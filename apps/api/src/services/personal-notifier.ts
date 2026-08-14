import { eq } from 'drizzle-orm'
import { notifications, reviews, notificationPreferences } from '@gatewerk/db'
import {
  categoryForEvent,
  generateId,
  NOTIFICATION_EVENTS,
  quietHoursDelaySeconds,
  DEFAULT_NOTIFICATION_PREFS,
} from '@gatewerk/shared'
import type { NotificationEvent } from '@gatewerk/shared'
import { resolveRecipients } from './notification-recipients'
import type { AppDb } from '@gatewerk/db'
import type { EventBus, EventData } from './events'

interface EnqueueEmailFallbackOpts {
  notificationId: string
  email: string
  delaySeconds: number
  reviewerId: string
  reviewId: string
}

interface PersonalNotifierDeps {
  enqueueEmailFallback?: (o: EnqueueEmailFallbackOpts) => Promise<void>
  // delaySeconds added (I-4): Slack now honours the same quiet-hours delay
  // the email fallback does, including the urgent bypass, instead of always
  // firing immediately regardless of the recipient's configured window.
  enqueueSlack?: (o: { notificationId: string; email: string; reviewerId: string; reviewId: string; delaySeconds: number }) => Promise<void>
}

export class PersonalNotifier {
  constructor(private db: AppDb, private deps: PersonalNotifierDeps = {}) {}

  register(eventBus: EventBus): void {
    for (const event of NOTIFICATION_EVENTS as readonly NotificationEvent[]) {
      eventBus.on(event, (data: EventData) => {
        void this.handleEvent(event, data).catch((err) =>
          console.error('[PersonalNotifier] handler error', event, err),
        )
      })
    }
  }

  private static readonly CHAIN_TERMINAL_EVENTS = new Set([
    'chain.completed',
    'chain.rejected',
  ])

  async handleEvent(
    event: string,
    data: { review_id?: string; notify_assignee?: string },
  ): Promise<void> {
    const category = categoryForEvent(event)
    if (!category || !data.review_id) return

    // Fetch the review row — assignee is read from DB, not from the event payload
    const [review] = await this.db
      .select({
        id: reviews.id,
        assignee: reviews.assignee,
        template_slug: reviews.template_slug,
        priority: reviews.priority,
      })
      .from(reviews)
      .where(eq(reviews.id, data.review_id))
      .limit(1)

    if (!review) return

    // Chain terminal events name their recipient explicitly or have none.
    // The event fires on the bus for every chain, including agent-started ones,
    // because SSE and the SDK wait helpers depend on it (C1 §5.1). But an
    // agent-started chain has no human to tap, and falling back to the review's
    // assignee would tap the last decider — the one person who already knows,
    // because they are the one who just acted.
    if (PersonalNotifier.CHAIN_TERMINAL_EVENTS.has(event) && !data.notify_assignee) return

    const recipients = await resolveRecipients(this.db, {
      id: review.id,
      assignee: data.notify_assignee ?? review.assignee ?? null,
    })
    if (recipients.length === 0) return

    const title = buildTitle(event, review.template_slug)

    for (const r of recipients) {
      const inserted = await this.db
        .insert(notifications)
        .values({
          id: generateId('notification'),
          reviewer_id: r.reviewerId,
          review_id: review.id,
          event,
          category,
          title,
          dedup_key: `${r.reviewerId}:${review.id}:${event}`,
        })
        .onConflictDoNothing({ target: notifications.dedup_key })
        .returning({ id: notifications.id })

      // Email fallback and Slack share one eligibility gate and (I-4) one
      // quiet-hours delay — Slack used to enqueue immediately regardless of
      // the recipient's configured window, so a user who set 22:00-07:00
      // and enabled Slack still got a 3am DM. Eligible when:
      // 1. The insert actually created a new row (not a dedup-suppressed no-op)
      // 2. The recipient has a non-null email address
      // 3. The event is not review.urgent (dedup: its paired review.created already enqueued)
      if (
        inserted.length > 0 &&
        r.email !== null &&
        event !== 'review.urgent' &&
        (this.deps.enqueueEmailFallback || this.deps.enqueueSlack)
      ) {
        const email = r.email
        const baseDelaySeconds =
          event === 'review.reminder' ||
          review.priority === 'high' ||
          review.priority === 'critical'
            ? 120
            : 600

        // Quiet hours are per recipient, so this is read inside the loop. A
        // missing prefs row means defaults, which have quiet_hours null and
        // therefore change nothing. The read is wrapped and defaults to
        // DEFAULT_NOTIFICATION_PREFS on error (I-3): a stored preference must
        // never be able to stop a notification, and neither must a failure
        // to read one. Before this, a transient DB error here propagated out
        // of handleEvent and aborted every remaining recipient in the loop,
        // leaving them with no ledger row at all, not merely no fallback
        // delivery — the ledger insert above already succeeded for this
        // recipient, but the recipients after it in the loop never got that
        // far.
        let prefs = DEFAULT_NOTIFICATION_PREFS
        try {
          const [pref] = await this.db
            .select({ prefs: notificationPreferences.prefs })
            .from(notificationPreferences)
            .where(eq(notificationPreferences.reviewer_id, r.reviewerId))
            .limit(1)
          prefs = pref?.prefs ?? DEFAULT_NOTIFICATION_PREFS
        } catch (err) {
          console.error('[PersonalNotifier] prefs read failed, defaulting', err)
        }

        const delaySeconds = quietHoursDelaySeconds({
          baseDelaySeconds,
          now: new Date(),
          quietHours: prefs.quiet_hours,
          timezone: prefs.timezone,
          // Urgency bypasses the window entirely. Reminders are deliberately
          // NOT urgent: a reminder at 3am is exactly what quiet hours are for.
          isUrgent: review.priority === 'high' || review.priority === 'critical',
        })

        if (this.deps.enqueueEmailFallback) {
          try {
            await this.deps.enqueueEmailFallback({
              notificationId: inserted[0].id,
              email,
              delaySeconds,
              reviewerId: r.reviewerId,
              reviewId: review.id,
            })
          } catch (err) {
            console.error('[PersonalNotifier] enqueueEmailFallback failed', err)
            // Intentional: enqueue failure must NOT break the ledger write
          }
        }

        if (this.deps.enqueueSlack) {
          try {
            await this.deps.enqueueSlack({
              notificationId: inserted[0].id,
              email,
              reviewerId: r.reviewerId,
              reviewId: review.id,
              delaySeconds,
            })
          } catch (err) {
            console.error('[PersonalNotifier] enqueueSlack failed', err)
            // Intentional: enqueue failure must NOT break the ledger write
          }
        }
      }
    }
  }
}

function buildTitle(event: string, templateSlug: string): string {
  switch (event) {
    case 'review.urgent':
      return `Urgent: ${templateSlug} needs you`
    case 'review.reminder':
      return `Reminder · ${templateSlug}`
    case 'review.decided':
      return `${templateSlug} was decided`
    case 'chain.completed':
      return `Chain completed: ${templateSlug}`
    case 'chain.rejected':
      return `Chain rejected: ${templateSlug}`
    default:
      return `Your turn: ${templateSlug}`
  }
}

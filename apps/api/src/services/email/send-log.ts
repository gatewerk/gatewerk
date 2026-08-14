import { and, desc, eq, gte } from 'drizzle-orm'
import { emailSends } from '@gatewerk/db'
import type { AppDb } from '@gatewerk/db'
import { generateId } from '@gatewerk/shared'
import { normalizeEmail } from './suppression'
import { maskEmail } from '../../lib/mask-email'

/**
 * How far back the address fallback in markSendFailure is willing to look
 * for a matching send. Named and exported rather than left as a magic
 * number so the bound is visible at the call site and adjustable in one
 * place. Without a bound, an ancient send to the same address can absorb a
 * fresh bounce and mis-attribute it to whichever tenant mailed that address
 * last, arbitrarily far in the past.
 */
export const ADDRESS_FALLBACK_WINDOW_HOURS = 72

/**
 * Record a delivered send so a later bounce or complaint can be attributed to a
 * tenant. The provider message id is the join key: nodemailer returns
 * `info.messageId` and Resend returns `data.id`, so one log serves both.
 *
 * Address is normalized with the same helper the suppression list uses, so the
 * webhook's address fallback can match rows regardless of casing.
 */
export async function recordSend(
  db: AppDb,
  input: {
    messageId: string
    organizationId: string | null
    address: string
    isTransactional: boolean
    /** Optional so existing callers that predate Task 6 (attribution to a
     *  notification) keep compiling without being touched; omitted stores
     *  null, same as an explicit null. */
    notificationId?: string | null
  },
): Promise<void> {
  await db
    .insert(emailSends)
    .values({
      id: generateId('email_send'),
      message_id: input.messageId,
      organization_id: input.organizationId,
      address: normalizeEmail(input.address),
      is_transactional: input.isTransactional,
      notification_id: input.notificationId ?? null,
    })
    .onConflictDoNothing({ target: emailSends.message_id })
}

/**
 * Attribute a bounce or complaint to the send that caused it.
 *
 * Preferred join is the provider message id. Resend's webhook payload carries
 * `data.email_id`, but we do not depend on it: when it is absent or matches
 * nothing, fall back to the most recent send to that address within
 * ADDRESS_FALLBACK_WINDOW_HOURS. Without the fallback a provider that omits
 * the id would silently stop the breaker counting anything; without the time
 * bound, an ancient send to the same address could absorb a fresh bounce and
 * mis-attribute it to whichever tenant mailed that address last.
 */
export async function markSendFailure(
  db: AppDb,
  args: { messageId?: string | null; address: string; kind: 'bounce' | 'complaint' },
): Promise<void> {
  const stamp = args.kind === 'bounce' ? { bounced_at: new Date() } : { complained_at: new Date() }

  if (args.messageId) {
    const updated = await db
      .update(emailSends)
      .set(stamp)
      .where(eq(emailSends.message_id, args.messageId))
      .returning({ id: emailSends.id })
    if (updated.length > 0) return
  }

  const fallbackCutoff = new Date(Date.now() - ADDRESS_FALLBACK_WINDOW_HOURS * 3600_000)
  const [recent] = await db
    .select({ id: emailSends.id, organization_id: emailSends.organization_id })
    .from(emailSends)
    .where(
      and(
        eq(emailSends.address, normalizeEmail(args.address)),
        gte(emailSends.created_at, fallbackCutoff),
      ),
    )
    .orderBy(desc(emailSends.created_at))
    .limit(1)
  if (!recent) return

  // The fallback is a known residual risk, not just a defensive branch: a
  // reviewer shared across two organizations who receives mail from both at
  // the same address can still have a bounce attributed to the wrong
  // tenant here, and at MIN_SAMPLE (20 sends) a breach needs only 2
  // bounces, so this is reachable rather than theoretical. Logged so the
  // rate this actually fires at is measurable instead of shipping as an
  // invisible residual.
  // Address is MASKED. This fires on bounces and complaints, so logging it raw
  // would put exactly the recipients whose mail is failing into the log stream,
  // and every other log in this service emits only a message and an error. The
  // domain survives masking, which is the part that carries the deliverability
  // signal: a whole domain failing looks different from one mailbox.
  console.warn('[email] bounce or complaint attributed via address fallback, not message id', {
    address: maskEmail(normalizeEmail(args.address)),
    organization_id: recent.organization_id,
    kind: args.kind,
  })

  await db.update(emailSends).set(stamp).where(eq(emailSends.id, recent.id))
}

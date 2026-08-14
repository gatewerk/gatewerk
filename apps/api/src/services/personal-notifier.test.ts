import { describe, it, expect, vi } from 'vitest'
import { PersonalNotifier } from './personal-notifier'
import { notifications, reviews, reviewers, notificationPreferences } from '@gatewerk/db'
import { projects } from '@gatewerk/db/src/schema/index'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../__tests__/helpers/test-db'
import { generateId, DEFAULT_NOTIFICATION_PREFS } from '@gatewerk/shared'
import bcrypt from 'bcryptjs'

// Seed helpers local to this test file
async function seedProject(db: any) {
  const [project] = await db
    .insert(projects)
    .values({
      id: generateId('project'),
      name: 'Test Project',
      hmac_secret: 'test-secret',
    })
    .returning()
  return project
}

async function seedReviewer(
  db: any,
  opts: { email: string; role?: string },
) {
  const [reviewer] = await db
    .insert(reviewers)
    .values({
      id: generateId('user'),
      email: opts.email,
      name: opts.email.split('@')[0],
      password_hash: await bcrypt.hash('password123', 1),
      role: opts.role ?? 'reviewer',
    })
    .returning()
  return reviewer
}

async function seedReview(
  db: any,
  opts: { project_id: string; assignee: string; priority?: string },
) {
  const [review] = await db
    .insert(reviews)
    .values({
      id: generateId('review'),
      project_id: opts.project_id,
      template_slug: 'invoice',
      payload: {},
      assignee: opts.assignee,
      ...(opts.priority ? { priority: opts.priority } : {}),
    })
    .returning()
  return review
}

describe('PersonalNotifier', () => {
  it('writes one ledger row for the assignee on review.created', async () => {
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const reviewer = await seedReviewer(db, { email: 'a@x.co', role: 'reviewer' })
    const review = await seedReview(db, { project_id: project.id, assignee: reviewer.id })

    const n = new PersonalNotifier(db)
    await n.handleEvent('review.created', { review_id: review.id })

    const rows = await db.select().from(notifications).where(eq(notifications.reviewer_id, reviewer.id))
    expect(rows).toHaveLength(1)
    expect(rows[0].category).toBe('oversight')
    expect(rows[0].read_at).toBeNull()
  })

  it('is idempotent — a duplicate event writes no second row', async () => {
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const reviewer = await seedReviewer(db, { email: 'b@x.co', role: 'reviewer' })
    const review = await seedReview(db, { project_id: project.id, assignee: reviewer.id })

    const n = new PersonalNotifier(db)
    await n.handleEvent('review.created', { review_id: review.id })
    await n.handleEvent('review.created', { review_id: review.id })

    const rows = await db.select().from(notifications).where(eq(notifications.reviewer_id, reviewer.id))
    expect(rows).toHaveLength(1)
  })

  it('ignores events with no category mapping', async () => {
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const reviewer = await seedReviewer(db, { email: 'c@x.co', role: 'reviewer' })
    const review = await seedReview(db, { project_id: project.id, assignee: reviewer.id })

    const n = new PersonalNotifier(db)
    await n.handleEvent('review.retried', { review_id: review.id })

    const rows = await db.select().from(notifications)
    expect(rows).toHaveLength(0)
  })

  it('enqueues a delayed email for an assignee with an email address', async () => {
    const calls: any[] = []
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const reviewer = await seedReviewer(db, { email: 'a@x.co', role: 'reviewer' })
    const review = await seedReview(db, { project_id: project.id, assignee: reviewer.id, priority: 'normal' })

    const n = new PersonalNotifier(db, { enqueueEmailFallback: async (o) => { calls.push(o) } })
    await n.handleEvent('review.created', { review_id: review.id })

    expect(calls).toHaveLength(1)
    expect(calls[0].delaySeconds).toBe(600)
    expect(calls[0].email).toBe('a@x.co')
  })

  it('uses 120s for high-priority reviews and does NOT double-enqueue on review.urgent', async () => {
    const calls: any[] = []
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const reviewer = await seedReviewer(db, { email: 'd@x.co', role: 'reviewer' })
    const review = await seedReview(db, { project_id: project.id, assignee: reviewer.id, priority: 'high' })

    const n = new PersonalNotifier(db, { enqueueEmailFallback: async (o) => { calls.push(o) } })
    await n.handleEvent('review.created', { review_id: review.id })
    await n.handleEvent('review.urgent', { review_id: review.id })

    expect(calls).toHaveLength(1)
    expect(calls[0].delaySeconds).toBe(120)
  })

  it('enqueues an immediate Slack job for an assignee with an email on review.created', async () => {
    const slackCalls: any[] = []
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const reviewer = await seedReviewer(db, { email: 'e@x.co', role: 'reviewer' })
    const review = await seedReview(db, { project_id: project.id, assignee: reviewer.id })

    const n = new PersonalNotifier(db, { enqueueSlack: async (o) => { slackCalls.push(o) } })
    await n.handleEvent('review.created', { review_id: review.id })

    expect(slackCalls).toHaveLength(1)
    expect(slackCalls[0].email).toBe('e@x.co')
    expect(slackCalls[0].reviewerId).toBe(reviewer.id)
    expect(slackCalls[0].reviewId).toBe(review.id)

    const rows = await db.select().from(notifications).where(eq(notifications.reviewer_id, reviewer.id))
    expect(slackCalls[0].notificationId).toBe(rows[0].id)
  })

  it('does NOT enqueue Slack again on review.urgent (deduped by event guard)', async () => {
    const slackCalls: any[] = []
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const reviewer = await seedReviewer(db, { email: 'f@x.co', role: 'reviewer' })
    const review = await seedReview(db, { project_id: project.id, assignee: reviewer.id })

    const n = new PersonalNotifier(db, { enqueueSlack: async (o) => { slackCalls.push(o) } })
    await n.handleEvent('review.created', { review_id: review.id })
    await n.handleEvent('review.urgent', { review_id: review.id })

    expect(slackCalls).toHaveLength(1)
  })

  // A quiet-hours window built to bracket the moment a job will actually fire
  // (now + the base delay, +/- a 5 minute buffer for test execution latency),
  // so the assertion does not depend on the wall clock time the suite runs at.
  function windowAround(fireInMs: number) {
    const fireAt = new Date(Date.now() + fireInMs)
    const pad = (n: number) => String(n).padStart(2, '0')
    const from = new Date(fireAt.getTime() - 5 * 60_000)
    const to = new Date(fireAt.getTime() + 5 * 60_000)
    return {
      start: `${pad(from.getUTCHours())}:${pad(from.getUTCMinutes())}`,
      end: `${pad(to.getUTCHours())}:${pad(to.getUTCMinutes())}`,
    }
  }

  it('defers the email fallback past the base delay when the recipient is in quiet hours', async () => {
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const reviewer = await seedReviewer(db, { email: 'g@x.co', role: 'reviewer' })
    await db.insert(notificationPreferences).values({
      reviewer_id: reviewer.id,
      prefs: {
        ...DEFAULT_NOTIFICATION_PREFS,
        quiet_hours: windowAround(600_000), // brackets now + the 600s base delay
        timezone: 'UTC',
      },
    })
    const review = await seedReview(db, { project_id: project.id, assignee: reviewer.id, priority: 'normal' })

    const enqueueEmailFallback = vi.fn(
      async (_o: { notificationId: string; email: string; delaySeconds: number; reviewerId: string; reviewId: string }) => {},
    )
    const n = new PersonalNotifier(db, { enqueueEmailFallback })
    await n.handleEvent('review.created', { review_id: review.id })

    expect(enqueueEmailFallback).toHaveBeenCalledWith(
      expect.objectContaining({ delaySeconds: expect.any(Number) }),
    )
    const call = enqueueEmailFallback.mock.lastCall?.[0]
    expect(call?.delaySeconds).toBeGreaterThan(600)
  })

  it('does not defer a critical priority review even when it lands inside quiet hours', async () => {
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const reviewer = await seedReviewer(db, { email: 'h@x.co', role: 'reviewer' })
    await db.insert(notificationPreferences).values({
      reviewer_id: reviewer.id,
      prefs: {
        ...DEFAULT_NOTIFICATION_PREFS,
        quiet_hours: windowAround(120_000), // brackets now + the 120s critical delay
        timezone: 'UTC',
      },
    })
    const review = await seedReview(db, { project_id: project.id, assignee: reviewer.id, priority: 'critical' })

    const enqueueEmailFallback = vi.fn(
      async (_o: { notificationId: string; email: string; delaySeconds: number; reviewerId: string; reviewId: string }) => {},
    )
    const n = new PersonalNotifier(db, { enqueueEmailFallback })
    await n.handleEvent('review.created', { review_id: review.id })

    expect(enqueueEmailFallback).toHaveBeenCalledWith(
      expect.objectContaining({ delaySeconds: expect.any(Number) }),
    )
    const call = enqueueEmailFallback.mock.lastCall?.[0]
    expect(call?.delaySeconds).toBe(120)
  })

  it('defers a review.reminder on a NORMAL priority review inside quiet hours (reminders are not urgent)', async () => {
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const reviewer = await seedReviewer(db, { email: 'i@x.co', role: 'reviewer' })
    await db.insert(notificationPreferences).values({
      reviewer_id: reviewer.id,
      prefs: {
        ...DEFAULT_NOTIFICATION_PREFS,
        quiet_hours: windowAround(120_000), // reminders use the 120s base delay too
        timezone: 'UTC',
      },
    })
    const review = await seedReview(db, { project_id: project.id, assignee: reviewer.id, priority: 'normal' })

    const enqueueEmailFallback = vi.fn(
      async (_o: { notificationId: string; email: string; delaySeconds: number; reviewerId: string; reviewId: string }) => {},
    )
    const n = new PersonalNotifier(db, { enqueueEmailFallback })
    await n.handleEvent('review.reminder', { review_id: review.id })

    expect(enqueueEmailFallback).toHaveBeenCalledWith(
      expect.objectContaining({ delaySeconds: expect.any(Number) }),
    )
    const call = enqueueEmailFallback.mock.lastCall?.[0]
    // A reminder gets the fast 120s cadence but is deliberately NOT urgent, so
    // quiet hours still apply — a reminder at 3am is exactly what they exist for.
    expect(call?.delaySeconds).toBeGreaterThan(120)
  })

  it('taps notify_assignee instead of the review assignee when the override is present', async () => {
    const { db } = await createTestDb()
    const project = await seedProject(db)
    // Deliberately two DIFFERENT people: the assignee decided the final step,
    // the owner started the chain. If they were the same reviewer this test
    // could pass even with the override silently ignored.
    const assignee = await seedReviewer(db, { email: 'decider@x.co' })
    const owner = await seedReviewer(db, { email: 'owner@x.co' })
    const review = await seedReview(db, { project_id: project.id, assignee: assignee.id })

    const n = new PersonalNotifier(db)
    await n.handleEvent('chain.completed', { review_id: review.id, notify_assignee: owner.email })

    const ownerRows = await db.select().from(notifications).where(eq(notifications.reviewer_id, owner.id))
    const assigneeRows = await db.select().from(notifications).where(eq(notifications.reviewer_id, assignee.id))
    expect(ownerRows).toHaveLength(1)
    expect(assigneeRows).toHaveLength(0)
  })

  it('taps NOBODY for a chain terminal event with no owner named', async () => {
    // C1 §5.1 changed this, and the change is the point. The chain.completed
    // bus emit used to be gated on the run having a human owner, so this shape
    // — a chain terminal event with no notify_assignee — was unreachable from
    // the emitter and the fallback below never ran. The emit is now
    // unconditional, because SSE and the SDK wait helpers need it for
    // agent-started runs too. Which makes the fallback reachable, and wrong:
    // the review's assignee on a finished chain is the person who just
    // decided it. Tapping them is telling someone the news they made.
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const assignee = await seedReviewer(db, { email: 'solo@x.co' })
    const review = await seedReview(db, { project_id: project.id, assignee: assignee.id })

    const n = new PersonalNotifier(db)
    await n.handleEvent('chain.completed', { review_id: review.id })

    const rows = await db.select().from(notifications).where(eq(notifications.reviewer_id, assignee.id))
    expect(rows).toHaveLength(0)
  })

  it('still taps the review assignee for an ordinary event with no override', async () => {
    // The fence on the above. The assignee fallback is how nearly every
    // notification finds its person; only chain TERMINAL events opt out of it.
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const assignee = await seedReviewer(db, { email: 'solo@x.co' })
    const review = await seedReview(db, { project_id: project.id, assignee: assignee.id })

    const n = new PersonalNotifier(db)
    await n.handleEvent('review.created', { review_id: review.id })

    const rows = await db.select().from(notifications).where(eq(notifications.reviewer_id, assignee.id))
    expect(rows).toHaveLength(1)
  })

  // I-4: Slack used to enqueue with no startAfter and no quiet-hours
  // awareness at all, so a user who set quiet hours and enabled Slack still
  // got a 3am DM. These mirror the email-fallback quiet-hours tests above,
  // but assert on the enqueueSlack call instead.
  it('defers the Slack enqueue past zero when the recipient is in quiet hours (non urgent)', async () => {
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const reviewer = await seedReviewer(db, { email: 'j@x.co', role: 'reviewer' })
    await db.insert(notificationPreferences).values({
      reviewer_id: reviewer.id,
      prefs: {
        ...DEFAULT_NOTIFICATION_PREFS,
        quiet_hours: windowAround(600_000), // brackets now + the 600s normal-priority base delay
        timezone: 'UTC',
      },
    })
    const review = await seedReview(db, { project_id: project.id, assignee: reviewer.id, priority: 'normal' })

    const enqueueSlack = vi.fn(
      async (_o: { notificationId: string; email: string; reviewerId: string; reviewId: string; delaySeconds: number }) => {},
    )
    const n = new PersonalNotifier(db, { enqueueSlack })
    await n.handleEvent('review.created', { review_id: review.id })

    expect(enqueueSlack).toHaveBeenCalledWith(
      expect.objectContaining({ delaySeconds: expect.any(Number) }),
    )
    const call = enqueueSlack.mock.lastCall?.[0]
    expect(call?.delaySeconds).toBeGreaterThan(0)
  })

  it('does not defer the Slack enqueue for a critical priority review even inside quiet hours (urgent bypass)', async () => {
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const reviewer = await seedReviewer(db, { email: 'k@x.co', role: 'reviewer' })
    await db.insert(notificationPreferences).values({
      reviewer_id: reviewer.id,
      prefs: {
        ...DEFAULT_NOTIFICATION_PREFS,
        quiet_hours: windowAround(120_000), // brackets now + the 120s critical-priority base delay
        timezone: 'UTC',
      },
    })
    const review = await seedReview(db, { project_id: project.id, assignee: reviewer.id, priority: 'critical' })

    const enqueueSlack = vi.fn(
      async (_o: { notificationId: string; email: string; reviewerId: string; reviewId: string; delaySeconds: number }) => {},
    )
    const n = new PersonalNotifier(db, { enqueueSlack })
    await n.handleEvent('review.created', { review_id: review.id })

    const call = enqueueSlack.mock.lastCall?.[0]
    expect(call?.delaySeconds).toBe(120)
  })

  // I-3: the notificationPreferences SELECT sat above the try that guards
  // enqueueEmailFallback, so a transient error reading it propagated out of
  // handleEvent and aborted every remaining recipient in the loop — they got
  // no ledger row at all, not merely no fallback delivery. Two recipients are
  // required: a single-recipient test cannot distinguish "degrades this one
  // recipient" from "aborts the whole fan-out".
  it('still writes a ledger row for the second recipient when the first recipient\'s prefs read throws', async () => {
    const { db } = await createTestDb()
    const project = await seedProject(db)
    const reviewerA = await seedReviewer(db, { email: 'n@x.co', role: 'reviewer' })
    const reviewerB = await seedReviewer(db, { email: 'o@x.co', role: 'reviewer' })
    const review = await seedReview(db, { project_id: project.id, assignee: 'role:reviewer', priority: 'normal' })

    // Force exactly the 3rd db.select() call to throw. Call #1 is the review
    // lookup in handleEvent; call #2 is resolveRecipients' role based lookup;
    // call #3 is whichever recipient's notificationPreferences read runs
    // first inside the fan-out loop. Calls before #3 must behave normally or
    // this test has nothing to fan out over.
    const originalSelect = db.select.bind(db)
    let callCount = 0
    const selectSpy = vi.spyOn(db, 'select').mockImplementation((...args: any[]) => {
      callCount += 1
      if (callCount === 3) {
        throw new Error('simulated prefs read failure')
      }
      return (originalSelect as any)(...args)
    })

    const n = new PersonalNotifier(db, { enqueueEmailFallback: async () => {} })
    await n.handleEvent('review.created', { review_id: review.id })

    selectSpy.mockRestore()

    const rows = await db.select().from(notifications).where(eq(notifications.review_id, review.id))
    expect(rows).toHaveLength(2)
    const reviewerIds = rows.map((r: any) => r.reviewer_id).sort()
    expect(reviewerIds).toEqual([reviewerA.id, reviewerB.id].sort())
  })
})

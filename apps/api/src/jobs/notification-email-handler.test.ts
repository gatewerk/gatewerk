import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTestDb } from '../__tests__/helpers/test-db'
import {
  notifications,
  notificationPreferences,
  organizations,
  organizationMemberships,
  projects,
  reviews,
  reviewers,
} from '@gatewerk/db'
import { generateId, DEFAULT_NOTIFICATION_PREFS } from '@gatewerk/shared'
import { handleNotificationEmail } from './notification-email-handler'

function fakeEmail() {
  const sent: any[] = []
  return {
    sent,
    sendEmail: vi.fn(async (i: any) => {
      sent.push(i)
      return { status: 'sent' as const, messageId: 'm' }
    }),
  }
}

async function seedNotif(db: any, over: Partial<any> = {}) {
  const id = generateId('notification')
  await db.insert(notifications).values({
    id,
    reviewer_id: 'rev1',
    review_id: null,
    event: 'review.created',
    category: 'oversight',
    title: 'Your turn · x',
    dedup_key: id,
    ...over,
  })
  return id
}

// Mirrors the seeding helpers in jobs/notification-slack-handler.test.ts,
// which established resolveTenantOrgId's own coverage. Duplicated locally
// rather than imported so this file's tests read standalone.
async function seedOrg(db: any, id: string) {
  await db.insert(organizations).values({ id, name: id, slug: id })
}

/** Reviewer rows are required before memberships — organization_memberships.user_id
 *  is an FK to reviewers(id). */
async function seedReviewerRow(db: any, id: string, email = `${id}@example.com`) {
  await db.insert(reviewers).values({
    id,
    email,
    name: id,
    password_hash: 'x',
  })
}

async function seedMembership(db: any, orgId: string, reviewerId: string) {
  await db.insert(organizationMemberships).values({
    id: generateId('omem'),
    organization_id: orgId,
    user_id: reviewerId,
  })
}

/** Creates a project (optionally org-owned) plus a review inside it, and returns
 *  the review id for use as notifications.review_id. */
async function seedReviewInOrg(db: any, orgId: string | null): Promise<string> {
  const projectId = generateId('project')
  await db.insert(projects).values({
    id: projectId,
    name: 'p',
    hmac_secret: 's',
    organization_id: orgId,
  })
  const reviewId = generateId('review')
  await db.insert(reviews).values({
    id: reviewId,
    project_id: projectId,
    template_slug: 'test',
    payload: {},
  })
  return reviewId
}

describe('handleNotificationEmail (read-aware)', () => {
  let db: any
  beforeEach(async () => {
    ;({ db } = await createTestDb())
  })

  it('sends when unread and email enabled (default prefs)', async () => {
    await seedReviewerRow(db, 'rev1')
    const id = await seedNotif(db)
    const email = fakeEmail()
    await handleNotificationEmail({ db, email }, { notificationId: id, email: 'a@x.co' })
    expect(email.sendEmail).toHaveBeenCalledTimes(1)
    expect(email.sent[0].is_transactional).toBe(true)
    expect(email.sent[0].to).toBe('a@x.co')
    // I-1: notification_id is the one field that lets a later bounce
    // (Task 6/7) be traced back to this notification row. It rode through
    // an untyped `(i: any)` dep with no assertion anywhere in this suite —
    // deleting the production line would have left every test here green.
    expect(email.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ notification_id: id }),
    )
  })

  it('skips when already read', async () => {
    await seedReviewerRow(db, 'rev1')
    const id = await seedNotif(db, { read_at: new Date() })
    const email = fakeEmail()
    await handleNotificationEmail({ db, email }, { notificationId: id, email: 'a@x.co' })
    expect(email.sendEmail).not.toHaveBeenCalled()
  })

  it('skips when the category email pref is off', async () => {
    await seedReviewerRow(db, 'rev1')
    const id = await seedNotif(db)
    // Insert prefs with oversight.email = false
    const prefsWithEmailOff = {
      ...DEFAULT_NOTIFICATION_PREFS,
      channels: {
        ...DEFAULT_NOTIFICATION_PREFS.channels,
        oversight: { email: false, slack: false },
      },
    }
    await db.insert(notificationPreferences).values({
      reviewer_id: 'rev1',
      prefs: prefsWithEmailOff,
    })
    const email = fakeEmail()
    await handleNotificationEmail({ db, email }, { notificationId: id, email: 'a@x.co' })
    expect(email.sendEmail).not.toHaveBeenCalled()
  })

  it('attributes the send to the organization that owns the notification review', async () => {
    await seedReviewerRow(db, 'rev1')
    await seedOrg(db, 'orgA')
    const reviewId = await seedReviewInOrg(db, 'orgA')
    const id = await seedNotif(db, { review_id: reviewId })

    const email = fakeEmail()
    await handleNotificationEmail({ db, email }, { notificationId: id, email: 'a@x.co' })

    expect(email.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: 'orgA' }),
    )
  })

  it('attributes the send to the reviewer\'s sole organization membership when there is no review', async () => {
    // Proves seedMembership actually creates a working membership row that
    // resolveTenantOrgId's fallback picks up. Without this sibling, the
    // ambiguous-tenant test below cannot be trusted: a resolveTenantOrgId
    // call that saw zero real memberships (e.g. seedMembership silently
    // failing) and one that saw two real, genuinely ambiguous memberships
    // both produce organization_id: null, so they are observationally
    // identical unless a sole-membership case is shown to resolve to a
    // real, non-null org first.
    await seedOrg(db, 'orgSolo')
    await seedReviewerRow(db, 'rev1')
    await seedMembership(db, 'orgSolo', 'rev1')
    const id = await seedNotif(db, { review_id: null })

    const email = fakeEmail()
    await handleNotificationEmail({ db, email }, { notificationId: id, email: 'a@x.co' })

    expect(email.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: 'orgSolo' }),
    )
  })

  it('still sends, with a null organization, when the tenant is ambiguous', async () => {
    // rev1 belongs to two orgs and the notification carries no review_id to
    // disambiguate — resolveTenantOrgId fails closed with { ok: false }.
    // The sole-membership test above establishes that seedMembership really
    // does create rows resolveTenantOrgId reads, so the two memberships
    // seeded here are real, not an artifact of a broken helper.
    await seedOrg(db, 'orgA')
    await seedOrg(db, 'orgB')
    await seedReviewerRow(db, 'rev1')
    await seedMembership(db, 'orgA', 'rev1')
    await seedMembership(db, 'orgB', 'rev1')
    const id = await seedNotif(db, { review_id: null })

    const email = fakeEmail()
    await handleNotificationEmail({ db, email }, { notificationId: id, email: 'a@x.co' })

    // A notification must never be dropped because its tenant was unclear.
    expect(email.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: null }),
    )
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../__tests__/helpers/test-db'
import {
  notifications,
  notificationPreferences,
  slackWorkspaces,
  slackUserLinks,
  organizations,
  organizationMemberships,
  projects,
  reviews,
  reviewers,
} from '@gatewerk/db'
import { generateId, DEFAULT_NOTIFICATION_PREFS } from '@gatewerk/shared'
import { encryptAtRest } from '../lib/secret-crypto'
import {
  handleNotificationSlack,
  resolveTenantOrgId,
  type Deps,
  type NotificationSlackJob,
} from './notification-slack-handler'

// 64 hex chars = 32-byte AES-256 key; safe for test use only.
const TEST_KEY = 'a'.repeat(64)
const FAKE_BOT_TOKEN = 'xoxb-test-bot-token'

function fakeSlack() {
  return {
    postMessage: vi.fn(async () => {}),
    usersLookupByEmail: vi.fn(async (_token: string, _email: string): Promise<string | null> => 'U_RESOLVED'),
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
    title: 'Your turn: agent fired a tool',
    dedup_key: id,
    ...over,
  })
  return id
}

async function seedWorkspace(db: any) {
  await db.insert(slackWorkspaces).values({
    id: 'ws1',
    team_id: 'T_TEST',
    team_name: 'Test Workspace',
    bot_token_encrypted: encryptAtRest(FAKE_BOT_TOKEN, TEST_KEY),
    bot_user_id: 'U_BOT',
    revoked_at: null,
  })
}

async function seedWorkspaceInOrg(
  db: any,
  opts: { id: string; teamId: string; orgId: string | null; token: string },
) {
  await db.insert(slackWorkspaces).values({
    id: opts.id,
    organization_id: opts.orgId,
    team_id: opts.teamId,
    team_name: opts.teamId,
    bot_token_encrypted: encryptAtRest(opts.token, TEST_KEY),
    bot_user_id: 'U_BOT',
    revoked_at: null,
  })
}

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
  // 'omem' is the ID_PREFIXES key for organization memberships — 'membership'
  // is not a valid ResourceType and will not typecheck.
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

describe('handleNotificationSlack', () => {
  let db: any

  beforeEach(async () => {
    ;({ db } = await createTestDb())
    // Inject the test encryption key into env for the handler to read.
    process.env.SLACK_TOKEN_ENCRYPTION_KEY = TEST_KEY
  })

  it('(a) linked reviewer + slack=true → postMessage called once to their slack_user_id', async () => {
    await seedReviewerRow(db, 'rev1')
    const id = await seedNotif(db)
    await seedWorkspace(db)

    // Pre-cache the reviewer's Slack user id.
    await db.insert(slackUserLinks).values({
      reviewer_id: 'rev1',
      slack_user_id: 'U_CACHED',
      slack_team_id: 'T_TEST',
    })

    // Enable oversight.slack in prefs.
    const prefsWithSlack = {
      ...DEFAULT_NOTIFICATION_PREFS,
      channels: {
        ...DEFAULT_NOTIFICATION_PREFS.channels,
        oversight: { email: true, slack: true },
      },
    }
    await db.insert(notificationPreferences).values({
      reviewer_id: 'rev1',
      prefs: prefsWithSlack,
    })

    const slack = fakeSlack()
    const deps: Deps = { db, slack }
    const job: NotificationSlackJob = { notificationId: id, email: 'rev1@example.com', reviewerId: 'rev1' }

    await handleNotificationSlack(deps, job)

    expect(slack.postMessage).toHaveBeenCalledTimes(1)
    // Second arg is the channel (slack user id). Use toHaveBeenCalledWith to
    // avoid the mock.calls tuple-length type error (Vitest types calls as []).
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.any(String), // botToken
      'U_CACHED',         // channel = slack user id
      expect.any(Array),  // blocks
      expect.any(String), // text
    )
    // usersLookupByEmail should NOT be called — cache hit.
    expect(slack.usersLookupByEmail).not.toHaveBeenCalled()
  })

  it('(b) oversight.slack=false → postMessage not called', async () => {
    await seedReviewerRow(db, 'rev1')
    const id = await seedNotif(db)
    await seedWorkspace(db)

    // Default prefs have slack=false — do NOT insert notificationPreferences
    // so the handler falls back to DEFAULT_NOTIFICATION_PREFS.

    const slack = fakeSlack()
    const deps: Deps = { db, slack }
    const job: NotificationSlackJob = { notificationId: id, email: 'rev1@example.com', reviewerId: 'rev1' }

    await handleNotificationSlack(deps, job)

    expect(slack.postMessage).not.toHaveBeenCalled()
  })

  it('(c) unlinked reviewer + usersLookupByEmail returns null → postMessage not called', async () => {
    await seedReviewerRow(db, 'rev1')
    const id = await seedNotif(db)
    await seedWorkspace(db)

    // Enable slack pref.
    const prefsWithSlack = {
      ...DEFAULT_NOTIFICATION_PREFS,
      channels: {
        ...DEFAULT_NOTIFICATION_PREFS.channels,
        oversight: { email: true, slack: true },
      },
    }
    await db.insert(notificationPreferences).values({
      reviewer_id: 'rev1',
      prefs: prefsWithSlack,
    })

    // No slack_user_links row — cache miss. usersLookupByEmail returns null.
    const slack = fakeSlack()
    slack.usersLookupByEmail = vi.fn(async (): Promise<string | null> => null)

    const deps: Deps = { db, slack }
    const job: NotificationSlackJob = { notificationId: id, email: 'rev1@example.com', reviewerId: 'rev1' }

    await handleNotificationSlack(deps, job)

    expect(slack.usersLookupByEmail).toHaveBeenCalledOnce()
    expect(slack.postMessage).not.toHaveBeenCalled()

    // Task 8: a failed lookup is recorded, not silently dropped — a
    // slack_user_links row now exists for the reviewer with lookup_failed_at
    // set, so GET /status can tell them why no DM arrived.
    const [link] = await db
      .select()
      .from(slackUserLinks)
      .where(eq(slackUserLinks.reviewer_id, 'rev1'))
    expect(link).toBeDefined()
    expect(link.lookup_failed_at).not.toBeNull()
  })

  it('(c2) a later successful lookup clears a previously recorded lookup_failed_at', async () => {
    await seedReviewerRow(db, 'rev1')
    const id = await seedNotif(db)
    await seedWorkspace(db)
    const prefsWithSlack = {
      ...DEFAULT_NOTIFICATION_PREFS,
      channels: {
        ...DEFAULT_NOTIFICATION_PREFS.channels,
        oversight: { email: true, slack: true },
      },
    }
    await db.insert(notificationPreferences).values({
      reviewer_id: 'rev1',
      prefs: prefsWithSlack,
    })

    // A stale failure flag from an earlier notification, before this
    // reviewer joined Slack.
    await db.insert(slackUserLinks).values({
      reviewer_id: 'rev1',
      slack_user_id: '',
      slack_team_id: 'T_TEST',
      lookup_failed_at: new Date(),
    })

    const slack = fakeSlack() // usersLookupByEmail resolves 'U_RESOLVED' by default
    const deps: Deps = { db, slack }
    const job: NotificationSlackJob = { notificationId: id, email: 'rev1@example.com', reviewerId: 'rev1' }

    await handleNotificationSlack(deps, job)

    expect(slack.postMessage).toHaveBeenCalledTimes(1)

    const [link] = await db
      .select()
      .from(slackUserLinks)
      .where(eq(slackUserLinks.reviewer_id, 'rev1'))
    expect(link.lookup_failed_at).toBeNull()
    expect(link.slack_user_id).toBe('U_RESOLVED')
  })

  it('(d) no workspace row → postMessage not called', async () => {
    await seedReviewerRow(db, 'rev1')
    const id = await seedNotif(db)
    // No slack_workspaces row inserted.

    // Enable slack pref.
    const prefsWithSlack = {
      ...DEFAULT_NOTIFICATION_PREFS,
      channels: {
        ...DEFAULT_NOTIFICATION_PREFS.channels,
        oversight: { email: true, slack: true },
      },
    }
    await db.insert(notificationPreferences).values({
      reviewer_id: 'rev1',
      prefs: prefsWithSlack,
    })

    const slack = fakeSlack()
    const deps: Deps = { db, slack }
    const job: NotificationSlackJob = { notificationId: id, email: 'rev1@example.com', reviewerId: 'rev1' }

    await handleNotificationSlack(deps, job)

    expect(slack.postMessage).not.toHaveBeenCalled()
    expect(slack.usersLookupByEmail).not.toHaveBeenCalled()
  })

  // Nested (not sibling) so it shares the outer `db` var and `beforeEach`
  // (fresh PGlite instance + SLACK_TOKEN_ENCRYPTION_KEY per test) — vitest
  // runs parent beforeEach hooks for nested describes too.
  describe('resolveTenantOrgId', () => {
    it('derives the org from the notification review → project → organization', async () => {
      await seedOrg(db, 'orgA')
      const reviewId = await seedReviewInOrg(db, 'orgA')

      const result = await resolveTenantOrgId(db, { reviewer_id: 'rev1', review_id: reviewId })

      expect(result).toEqual({ ok: true, orgId: 'orgA' })
    })

    it('review path wins over membership fallback: OSS review with org-null project overrides an unrelated org membership', async () => {
      const reviewId = await seedReviewInOrg(db, null)

      // rev1 is a member of a DIFFERENT org. A resolver that (bug) checks
      // `row?.organization_id` truthiness instead of `row` existence would
      // fall through to this membership and wrongly return 'orgOther' —
      // this seed is what makes that fallthrough surface as a wrong orgId
      // instead of a coincidentally-correct null.
      await seedOrg(db, 'orgOther')
      await seedReviewerRow(db, 'rev1')
      await seedMembership(db, 'orgOther', 'rev1')

      const result = await resolveTenantOrgId(db, { reviewer_id: 'rev1', review_id: reviewId })

      expect(result).toEqual({ ok: true, orgId: null })
    })

    it('falls back to the sole membership when the notification has no review', async () => {
      await seedOrg(db, 'orgA')
      await seedReviewerRow(db, 'rev1')
      await seedMembership(db, 'orgA', 'rev1')

      const result = await resolveTenantOrgId(db, { reviewer_id: 'rev1', review_id: null })

      expect(result).toEqual({ ok: true, orgId: 'orgA' })
    })

    it('returns orgId null when there is no review and no membership (OSS)', async () => {
      const result = await resolveTenantOrgId(db, { reviewer_id: 'rev1', review_id: null })

      expect(result).toEqual({ ok: true, orgId: null })
    })

    it('fails closed when there is no review and the reviewer belongs to several orgs', async () => {
      await seedOrg(db, 'orgA')
      await seedOrg(db, 'orgB')
      await seedReviewerRow(db, 'rev1')
      await seedMembership(db, 'orgA', 'rev1')
      await seedMembership(db, 'orgB', 'rev1')

      const result = await resolveTenantOrgId(db, { reviewer_id: 'rev1', review_id: null })

      expect(result).toEqual({ ok: false })
    })
  })

  describe('handleNotificationSlack — org scoping', () => {
    const OTHER_ORG_TOKEN = 'xoxb-other-org-token'
    const OWN_ORG_TOKEN = 'xoxb-own-org-token'

    /** Same prefs shape the existing tests inline; extracted here because five
     *  new cases need it. Leave the existing tests' inlined copies alone. */
    async function enableSlackPref(db: any, reviewerId: string) {
      await db.insert(notificationPreferences).values({
        reviewer_id: reviewerId,
        prefs: {
          ...DEFAULT_NOTIFICATION_PREFS,
          channels: {
            ...DEFAULT_NOTIFICATION_PREFS.channels,
            oversight: { email: true, slack: true },
          },
        },
      })
    }

    it('uses the workspace of the org that owns the review, not another org', async () => {
      await seedReviewerRow(db, 'rev1')
      await seedOrg(db, 'orgA')
      await seedOrg(db, 'orgB')
      await seedWorkspaceInOrg(db, { id: 'wsA', teamId: 'T_A', orgId: 'orgA', token: OTHER_ORG_TOKEN })
      await seedWorkspaceInOrg(db, { id: 'wsB', teamId: 'T_B', orgId: 'orgB', token: OWN_ORG_TOKEN })

      const reviewId = await seedReviewInOrg(db, 'orgB')
      const id = await seedNotif(db, { review_id: reviewId })
      await enableSlackPref(db, 'rev1')

      const slack = fakeSlack()
      const deps: Deps = { db, slack }
      const job: NotificationSlackJob = { notificationId: id, email: 'rev1@example.com', reviewerId: 'rev1' }

      await handleNotificationSlack(deps, job)

      expect(slack.usersLookupByEmail).toHaveBeenCalledWith(OWN_ORG_TOKEN, 'rev1@example.com')
      expect(slack.postMessage).toHaveBeenCalledTimes(1)
      // Assert via toHaveBeenCalledWith, never slack.postMessage.mock.calls[0][0] —
      // Vitest types mock.calls as [] here and indexing it fails typecheck.
      expect(slack.postMessage).toHaveBeenCalledWith(
        OWN_ORG_TOKEN,
        'U_RESOLVED',
        expect.any(Array),
        expect.any(String),
      )
    })

    it('does not deliver when the owning org has no connected workspace', async () => {
      await seedReviewerRow(db, 'rev1')
      await seedOrg(db, 'orgA')
      await seedOrg(db, 'orgB')
      await seedWorkspaceInOrg(db, { id: 'wsA', teamId: 'T_A', orgId: 'orgA', token: OTHER_ORG_TOKEN })

      const reviewId = await seedReviewInOrg(db, 'orgB')
      const id = await seedNotif(db, { review_id: reviewId })
      await enableSlackPref(db, 'rev1')

      const slack = fakeSlack()
      const deps: Deps = { db, slack }
      const job: NotificationSlackJob = { notificationId: id, email: 'rev1@example.com', reviewerId: 'rev1' }

      await handleNotificationSlack(deps, job)

      expect(slack.usersLookupByEmail).not.toHaveBeenCalled()
      expect(slack.postMessage).not.toHaveBeenCalled()
    })

    it('ignores a cached link pointing at another org and re-resolves within the owning org', async () => {
      await seedReviewerRow(db, 'rev1')
      await seedOrg(db, 'orgA')
      await seedOrg(db, 'orgB')
      await seedWorkspaceInOrg(db, { id: 'wsA', teamId: 'T_A', orgId: 'orgA', token: OTHER_ORG_TOKEN })
      await seedWorkspaceInOrg(db, { id: 'wsB', teamId: 'T_B', orgId: 'orgB', token: OWN_ORG_TOKEN })

      // Stale/poisoned cache row binding the reviewer to org A's Slack team.
      await db.insert(slackUserLinks).values({
        reviewer_id: 'rev1',
        slack_user_id: 'U_WRONG_ORG',
        slack_team_id: 'T_A',
        cached_at: new Date(),
      })

      const reviewId = await seedReviewInOrg(db, 'orgB')
      const id = await seedNotif(db, { review_id: reviewId })
      await enableSlackPref(db, 'rev1')

      const slack = fakeSlack()
      const deps: Deps = { db, slack }
      const job: NotificationSlackJob = { notificationId: id, email: 'rev1@example.com', reviewerId: 'rev1' }

      await handleNotificationSlack(deps, job)

      expect(slack.postMessage).toHaveBeenCalledWith(
        OWN_ORG_TOKEN,
        'U_RESOLVED',
        expect.any(Array),
        expect.any(String),
      )

      // The poisoned link is healed, not left pointing at org A.
      const [link] = await db
        .select()
        .from(slackUserLinks)
        .where(eq(slackUserLinks.reviewer_id, 'rev1'))
      expect(link.slack_team_id).toBe('T_B')
      expect(link.slack_user_id).toBe('U_RESOLVED')
    })

    it('does not deliver when the tenant is ambiguous (no review, several orgs)', async () => {
      await seedOrg(db, 'orgA')
      await seedOrg(db, 'orgB')
      await seedReviewerRow(db, 'rev1')
      await seedMembership(db, 'orgA', 'rev1')
      await seedMembership(db, 'orgB', 'rev1')
      await seedWorkspaceInOrg(db, { id: 'wsA', teamId: 'T_A', orgId: 'orgA', token: OTHER_ORG_TOKEN })

      const id = await seedNotif(db, { review_id: null })
      await enableSlackPref(db, 'rev1')

      const slack = fakeSlack()
      const deps: Deps = { db, slack }
      const job: NotificationSlackJob = { notificationId: id, email: 'rev1@example.com', reviewerId: 'rev1' }

      await handleNotificationSlack(deps, job)

      expect(slack.postMessage).not.toHaveBeenCalled()
    })

    it('still delivers in OSS, where the project and the workspace both have no org', async () => {
      await seedReviewerRow(db, 'rev1')
      await seedWorkspaceInOrg(db, { id: 'wsOss', teamId: 'T_OSS', orgId: null, token: OWN_ORG_TOKEN })

      const reviewId = await seedReviewInOrg(db, null)
      const id = await seedNotif(db, { review_id: reviewId })
      await enableSlackPref(db, 'rev1')

      const slack = fakeSlack()
      const deps: Deps = { db, slack }
      const job: NotificationSlackJob = { notificationId: id, email: 'rev1@example.com', reviewerId: 'rev1' }

      await handleNotificationSlack(deps, job)

      expect(slack.postMessage).toHaveBeenCalledTimes(1)
      expect(slack.postMessage).toHaveBeenCalledWith(
        OWN_ORG_TOKEN,
        'U_RESOLVED',
        expect.any(Array),
        expect.any(String),
      )
    })

    // Regression test for the write side bug: routes/slack.ts used to derive
    // organization_id from req.organizationId ?? null, but every real project
    // (OSS seed.ts's Default Organization, or an EE provisioned org) carries a
    // REAL organization_id. A workspace stored with a null org would never
    // match that real project's org and delivery would silently stop. This
    // seeds the shape production actually has: one real org owning both the
    // project and the workspace, no second org for scoping to hide behind.
    it('delivers when a single real organization owns both the project and the workspace, the actual production shape', async () => {
      await seedReviewerRow(db, 'rev1')
      await seedOrg(db, 'orgSolo')
      await seedWorkspaceInOrg(db, { id: 'wsSolo', teamId: 'T_SOLO', orgId: 'orgSolo', token: OWN_ORG_TOKEN })

      const reviewId = await seedReviewInOrg(db, 'orgSolo')
      const id = await seedNotif(db, { review_id: reviewId })
      await enableSlackPref(db, 'rev1')

      const slack = fakeSlack()
      const deps: Deps = { db, slack }
      const job: NotificationSlackJob = { notificationId: id, email: 'rev1@example.com', reviewerId: 'rev1' }

      await handleNotificationSlack(deps, job)

      expect(slack.postMessage).toHaveBeenCalledTimes(1)
      expect(slack.postMessage).toHaveBeenCalledWith(
        OWN_ORG_TOKEN,
        'U_RESOLVED',
        expect.any(Array),
        expect.any(String),
      )
    })

    it('a cache hit within a non null organization DMs the cached slack user id without a lookup', async () => {
      await seedReviewerRow(db, 'rev1')
      await seedOrg(db, 'orgCache')
      await seedWorkspaceInOrg(db, { id: 'wsCache', teamId: 'T_CACHE', orgId: 'orgCache', token: OWN_ORG_TOKEN })

      const reviewId = await seedReviewInOrg(db, 'orgCache')
      const id = await seedNotif(db, { review_id: reviewId })
      await enableSlackPref(db, 'rev1')

      await db.insert(slackUserLinks).values({
        reviewer_id: 'rev1',
        slack_user_id: 'U_CACHED_ORG',
        slack_team_id: 'T_CACHE',
        cached_at: new Date(),
      })

      const slack = fakeSlack()
      const deps: Deps = { db, slack }
      const job: NotificationSlackJob = { notificationId: id, email: 'rev1@example.com', reviewerId: 'rev1' }

      await handleNotificationSlack(deps, job)

      expect(slack.postMessage).toHaveBeenCalledWith(
        OWN_ORG_TOKEN,
        'U_CACHED_ORG',
        expect.any(Array),
        expect.any(String),
      )
      expect(slack.usersLookupByEmail).not.toHaveBeenCalled()
    })

    // Cache re validation against slack_workspaces.revoked_at had no test for
    // the fall through it introduced: a cached link whose
    // workspace has since been revoked (disconnect then reconnect) must not be
    // treated as a cache hit, and delivery must re resolve within the SAME org
    // rather than giving up.
    it('a cached link pointing at a revoked workspace re resolves to the non revoked workspace in the same organization', async () => {
      await seedReviewerRow(db, 'rev1')
      await seedOrg(db, 'orgRevoke')
      await db.insert(slackWorkspaces).values({
        id: 'wsRevoked',
        organization_id: 'orgRevoke',
        team_id: 'T_REVOKED',
        team_name: 'T_REVOKED',
        bot_token_encrypted: encryptAtRest('xoxb-revoked-token', TEST_KEY),
        bot_user_id: 'U_BOT',
        revoked_at: new Date(),
      })
      await seedWorkspaceInOrg(db, { id: 'wsFresh', teamId: 'T_FRESH', orgId: 'orgRevoke', token: OWN_ORG_TOKEN })

      const reviewId = await seedReviewInOrg(db, 'orgRevoke')
      const id = await seedNotif(db, { review_id: reviewId })
      await enableSlackPref(db, 'rev1')

      // Stale cache row from before the workspace was revoked.
      await db.insert(slackUserLinks).values({
        reviewer_id: 'rev1',
        slack_user_id: 'U_STALE',
        slack_team_id: 'T_REVOKED',
        cached_at: new Date(),
      })

      const slack = fakeSlack()
      const deps: Deps = { db, slack }
      const job: NotificationSlackJob = { notificationId: id, email: 'rev1@example.com', reviewerId: 'rev1' }

      await handleNotificationSlack(deps, job)

      expect(slack.postMessage).toHaveBeenCalledWith(
        OWN_ORG_TOKEN,
        'U_RESOLVED',
        expect.any(Array),
        expect.any(String),
      )

      const [link] = await db
        .select()
        .from(slackUserLinks)
        .where(eq(slackUserLinks.reviewer_id, 'rev1'))
      expect(link.slack_team_id).toBe('T_FRESH')
      expect(link.slack_user_id).toBe('U_RESOLVED')
    })
  })
})

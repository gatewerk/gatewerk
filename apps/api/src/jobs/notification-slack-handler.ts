import { eq, and, isNull, asc } from 'drizzle-orm'
import {
  notifications,
  notificationPreferences,
  slackWorkspaces,
  slackUserLinks,
  organizationMemberships,
  projects,
  reviews,
} from '@gatewerk/db'
import { DEFAULT_NOTIFICATION_PREFS, type NotificationCategory } from '@gatewerk/shared'
import type { AppDb } from '@gatewerk/db'
import { serverEnv } from '../env'
import { decryptAtRest } from '../lib/secret-crypto'
import { config } from '../config'
import { buildNotificationSlackMessage } from '../services/jobs/notification-slack-message'

export interface NotificationSlackJob {
  notificationId: string
  email: string
  reviewerId: string
}

export interface Deps {
  db: AppDb
  slack: {
    usersLookupByEmail: (botToken: string, email: string) => Promise<string | null>
    postMessage: (botToken: string, channel: string, blocks: unknown[], text: string) => Promise<void>
  }
}

/**
 * Which organization owns this notification.
 *
 * `orgId: null` means no organization could be attributed, NOT "OSS". A
 * seeded OSS install actually resolves to a REAL org id here: seed.ts grants
 * the admin reviewer an organization_memberships row as owner of the Default
 * Organization (seed.ts:184-191), so that reviewer has exactly one
 * membership and hits the sole-membership branch below, never this null
 * case. (OSS DOES create organizations rows more generally too: seed.ts
 * stamps that Default Organization on the demo project, and both project
 * creation paths, seed.ts and ee/auth/provision.ts, set a non null
 * projects.organization_id.)
 *
 * Null is reached only by a reviewer with zero memberships at all, which
 * means an install with no organizations row whatsoever (this repo's own
 * pglite test seeding via seedTestProject is exactly that shape, one
 * production never has), or by a caller that never opted a notification
 * into tenant attribution in the first place, such as authentication mail or
 * a diagnostic test send. Its `slack_workspaces` row carries a NULL
 * organization_id in that case and must be matched with IS NULL, not
 * skipped.
 *
 * `{ ok: false }` means the tenant is ambiguous. Callers must NOT deliver:
 * picking arbitrarily is exactly the cross-tenant leak this resolver exists
 * to prevent.
 */
export type TenantOrg = { ok: true; orgId: string | null } | { ok: false }

export async function resolveTenantOrgId(
  db: AppDb,
  n: { reviewer_id: string; review_id: string | null },
): Promise<TenantOrg> {
  // Preferred path: the review the notification is about names its tenant
  // exactly, and is unambiguous even for a reviewer who belongs to several orgs.
  if (n.review_id) {
    const [row] = await db
      .select({ organization_id: projects.organization_id })
      .from(reviews)
      .innerJoin(projects, eq(reviews.project_id, projects.id))
      .where(eq(reviews.id, n.review_id))
      .limit(1)
    if (row) return { ok: true, orgId: row.organization_id }
    // Review vanished (should be impossible — notifications cascade-delete with
    // reviews) — fall through to membership rather than guessing.
  }

  // Fallback for review-less notifications: the reviewer's own membership.
  const memberships = await db
    .select({ organization_id: organizationMemberships.organization_id })
    .from(organizationMemberships)
    .where(eq(organizationMemberships.user_id, n.reviewer_id))
    .limit(2)

  if (memberships.length === 0) return { ok: true, orgId: null } // OSS
  if (memberships.length === 1) return { ok: true, orgId: memberships[0].organization_id }
  return { ok: false } // several orgs, no review to disambiguate → fail closed
}

/**
 * Handles an `oss.notification-slack` job by sending a Block Kit DM to the
 * reviewer on Slack.
 *
 * Delivery is NOT read-aware — unlike the email handler, this handler does
 * not check `read_at`. Slack delivers immediately on job execution.
 *
 * Resolution flow:
 * 1. Load the notification; if missing → return.
 * 2. Load reviewer prefs; gate on `prefs.channels[cat].slack` (DEFAULT = false → skip).
 * 3. Require `SLACK_TOKEN_ENCRYPTION_KEY`; if absent → skip gracefully.
 * 4. Resolve the owning organization (`resolveTenantOrgId`); ambiguous → skip.
 * 5a. Cache HIT: `slack_user_links` by reviewer_id → workspace by team_id,
 *     non-revoked AND in the owning org → decrypt token → DM the cached user id.
 * 5b. Otherwise: find the owning org's non-revoked workspace (deterministic
 *     order) → decrypt token → `usersLookupByEmail`; null → skip. Upsert the
 *     `slack_user_links` row → DM the resolved slack_user_id.
 */
export async function handleNotificationSlack(deps: Deps, job: NotificationSlackJob): Promise<void> {
  // Step 1: load notification (no read_at check — Slack is not read-aware).
  const [n] = await deps.db
    .select()
    .from(notifications)
    .where(eq(notifications.id, job.notificationId))
    .limit(1)
  if (!n) return

  // Step 2: load prefs and gate on slack toggle for this category.
  const [pref] = await deps.db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.reviewer_id, n.reviewer_id))
    .limit(1)
  const prefs = pref?.prefs ?? DEFAULT_NOTIFICATION_PREFS
  const cat = n.category as NotificationCategory
  if (!prefs.channels[cat]?.slack) return

  // Step 3: require encryption key.
  const keyHex = serverEnv.SLACK_TOKEN_ENCRYPTION_KEY
  if (!keyHex) return

  // Step 4: resolve the tenant that owns this notification. Every workspace
  // lookup below is filtered by it, so a cloud multi-org deploy can never DM
  // through another organization's bot token.
  const tenant = await resolveTenantOrgId(deps.db, n)
  if (!tenant.ok) return
  const orgScope =
    tenant.orgId === null
      ? isNull(slackWorkspaces.organization_id)
      : eq(slackWorkspaces.organization_id, tenant.orgId)

  // Step 5: resolve bot token + slack user id.
  let botToken: string
  let slackUserId: string

  // Step 5a: check cache. The cached workspace must still be in the owning org —
  // a link written before this scoping existed, or left behind by an org move,
  // would otherwise keep routing through the wrong tenant forever.
  const [link] = await deps.db
    .select()
    .from(slackUserLinks)
    .where(eq(slackUserLinks.reviewer_id, n.reviewer_id))
    .limit(1)

  const [cachedWs] = link
    ? await deps.db
        .select()
        .from(slackWorkspaces)
        .where(
          and(
            eq(slackWorkspaces.team_id, link.slack_team_id),
            isNull(slackWorkspaces.revoked_at),
            orgScope,
          ),
        )
        .limit(1)
    : []

  // A row written by the users_not_found branch below (Task 8) carries an
  // empty slack_user_id and a set lookup_failed_at — it is a record of a
  // failed attempt, not a usable cache entry. Without this exclusion it
  // would satisfy `link && cachedWs` and postMessage would be called with an
  // empty channel string. Excluding it here means every notification after
  // a failure retries the lookup, which is what lets a later success clear
  // the flag.
  if (link && cachedWs && !link.lookup_failed_at) {
    botToken = decryptAtRest(cachedWs.bot_token_encrypted, keyHex)
    slackUserId = link.slack_user_id
  } else {
    // Step 5b: no usable cache (missing, revoked, or out-of-org) — resolve fresh
    // within the owning org. Ordering keeps the choice deterministic when one org
    // has connected more than one Slack team.
    const [ws] = await deps.db
      .select()
      .from(slackWorkspaces)
      .where(and(isNull(slackWorkspaces.revoked_at), orgScope))
      .orderBy(asc(slackWorkspaces.created_at), asc(slackWorkspaces.id))
      .limit(1)
    if (!ws) return
    botToken = decryptAtRest(ws.bot_token_encrypted, keyHex)

    // Look up the reviewer by email.
    const resolved = await deps.slack.usersLookupByEmail(botToken, job.email)
    if (!resolved) {
      // users_not_found (Task 8): record it so the connected Slack status
      // can tell the reviewer we looked and could not find them, instead of
      // silently skipping the DM forever with nothing anywhere explaining
      // why. slack_user_id is empty — there is no id to store — and
      // lookup_failed_at is the flag GET /status reads. Upserted (not
      // inserted) so a reviewer who previously linked and later
      // disconnected from Slack has their stale link row overwritten
      // rather than colliding on the primary key.
      await deps.db
        .insert(slackUserLinks)
        .values({
          reviewer_id: n.reviewer_id,
          slack_user_id: '',
          slack_team_id: ws.team_id,
          cached_at: new Date(),
          lookup_failed_at: new Date(),
        })
        .onConflictDoUpdate({
          target: slackUserLinks.reviewer_id,
          set: {
            slack_user_id: '',
            slack_team_id: ws.team_id,
            cached_at: new Date(),
            lookup_failed_at: new Date(),
          },
        })
      return // users_not_found — graceful skip
    }

    slackUserId = resolved

    // Upsert the cache row. lookup_failed_at is explicitly cleared: a
    // reviewer who previously had no matching Slack account and has since
    // joined must stop being flagged (Task 8) — otherwise a resolved
    // success would leave a stale failure flag behind forever.
    await deps.db
      .insert(slackUserLinks)
      .values({
        reviewer_id: n.reviewer_id,
        slack_user_id: slackUserId,
        slack_team_id: ws.team_id,
        cached_at: new Date(),
        lookup_failed_at: null,
      })
      .onConflictDoUpdate({
        target: slackUserLinks.reviewer_id,
        set: {
          slack_user_id: slackUserId,
          slack_team_id: ws.team_id,
          cached_at: new Date(),
          lookup_failed_at: null,
        },
      })
  }

  // Step 6: build and send the Block Kit message.
  const { blocks, text } = buildNotificationSlackMessage(n.title, config.uiOrigin)
  await deps.slack.postMessage(botToken, slackUserId, blocks, text)
}

import { and, eq, gte, isNotNull, sql } from 'drizzle-orm'
import { emailSends, organizations } from '@gatewerk/db'
import type { AppDb } from '@gatewerk/db'
import type { AuditService } from '../services/audit'
import { isTenantPaused, pauseTenant } from '../services/email/pause'

export const PAUSE_WINDOW_HOURS = 24
export const MIN_SAMPLE = 20
export const BOUNCE_RATE_LIMIT = 0.05 // 5%
export const COMPLAINT_RATE_LIMIT = 0.001 // 0.1%

/**
 * Hourly per-tenant deliverability circuit breaker.
 *
 * Groups the last PAUSE_WINDOW_HOURS of attributed sends by organization and
 * pauses any tenant whose bounce or complaint rate breaches its threshold,
 * provided it has at least MIN_SAMPLE sends behind it. Below that floor a
 * rate is noise, not signal: one bounce out of two sends is 50% and means
 * nothing. Rows with no organization_id are skipped, since there is no
 * tenant to pause.
 *
 * Per tenant, the window start is clamped to that tenant's own
 * email_resumed_at when later than the global PAUSE_WINDOW_HOURS boundary
 * (Fix 1), so rows predating an operator's resume never count toward a
 * fresh breach.
 *
 * Never resumes automatically. The breaker can tell a rate crossed a line;
 * it cannot tell whether the underlying cause (a bad list, a broken
 * template, a compromised sender) was fixed, so unpausing stays a human
 * decision made through the admin resume route.
 *
 * `audit` is injected rather than constructed here. `createAuditService(db)`
 * closes over an in-memory chain-tip cache keyed by db instance; a second,
 * independently constructed instance writing the same "system" partition as
 * the app's own instance forks the hash chain, and verify() then reports a
 * false chain_break on legitimate rows. The app boots exactly one instance
 * (app.ts) and this job's caller (start-oss-jobs.ts) already has it in
 * scope, the same way the admin resume route receives it rather than
 * building its own.
 */
export async function evaluateEmailPause(db: AppDb, audit: AuditService, now?: Date): Promise<void> {
  const windowStart = new Date((now ?? new Date()).getTime() - PAUSE_WINDOW_HOURS * 3600_000)

  const rows = await db
    .select({
      organization_id: emailSends.organization_id,
      total: sql<number>`cast(count(*) as int)`,
      bounced: sql<number>`cast(count(${emailSends.bounced_at}) as int)`,
      complained: sql<number>`cast(count(${emailSends.complained_at}) as int)`,
    })
    .from(emailSends)
    // Joined so each row's effective window start can be clamped to ITS OWN
    // tenant's email_resumed_at (Fix 1), not just the global 24h boundary.
    // Without this, a resumed tenant's pre resume rows keep counting against
    // it until they age out of the full 24h window on their own — up to 24h
    // during which mail stays paused 59 minutes of every 60, so the rows
    // can never dilute out and the resume route is a no op in practice.
    .innerJoin(organizations, eq(emailSends.organization_id, organizations.id))
    .where(
      and(
        isNotNull(emailSends.organization_id),
        // Plain, sargable lower bound so the planner can still use
        // email_sends_org_created_at_idx (organization_id, created_at DESC)
        // for a range scan on a table that grows with every send. This is
        // logically redundant with the clamp below on its own — greatest()
        // is always >= windowStart, so the clamp already implies this — but
        // the raw sql`` clamp is not sargable by itself, so keeping this
        // plain comparison alongside it is what lets the index still apply;
        // the clamp then narrows the result further per tenant. Selects
        // exactly the same rows as the clamp alone, not a superset.
        gte(emailSends.created_at, windowStart),
        // greatest()/coalesce() run in SQL so this stays one query instead of
        // a per organization round trip. coalesce falls back to the global
        // windowStart for a tenant that has never been resumed, so this is a
        // pure no op for every tenant Fix 1 does not touch.
        // `.toISOString()` and the explicit cast are load-bearing, not style.
        // `gte()` above serialises windowStart through the COLUMN's type
        // mapper, which is why it binds fine. Inside a raw sql`` fragment
        // there is no column to infer from, so a JS Date reaches postgres.js
        // untyped and the driver throws ERR_INVALID_ARG_TYPE at Bind. This
        // job therefore failed EVERY hourly run in cloud production.
        //
        // The 13 tests over this file did not catch it: they run on PGlite,
        // which accepts a Date here, while production runs postgres.js. Any
        // future raw fragment binding a Date has the same blind spot.
        sql`${emailSends.created_at} >= greatest(${windowStart.toISOString()}::timestamptz, coalesce(${organizations.email_resumed_at}, ${windowStart.toISOString()}::timestamptz))`,
      ),
    )
    .groupBy(emailSends.organization_id)

  for (const row of rows) {
    const orgId = row.organization_id
    if (!orgId) continue // isNotNull already filters this; guard narrows the type

    if (row.total < MIN_SAMPLE) continue

    const bounceRate = row.bounced / row.total
    const complaintRate = row.complained / row.total

    const breach =
      bounceRate > BOUNCE_RATE_LIMIT
        ? { metric: 'bounce', rate: bounceRate }
        : complaintRate > COMPLAINT_RATE_LIMIT
          ? { metric: 'complaint', rate: complaintRate }
          : null
    if (!breach) continue

    // Already paused: resuming is a human decision, so a still breached
    // tenant is left alone rather than re paused and re audited every hour.
    if (await isTenantPaused(db, orgId)) continue

    // Percent, not the raw fraction: the complaint limit is 0.1%, so a
    // breaching complaint rate as a raw fraction (e.g. 0.002) renders as
    // "0.00" at two decimal places and tells an operator nothing. As a
    // percentage the same rate reads as "0.20%", legible at either
    // threshold's order of magnitude.
    const reason = `${breach.metric} rate ${(breach.rate * 100).toFixed(2)}% over ${row.total} sends in ${PAUSE_WINDOW_HOURS}h`

    // Audit BEFORE pauseTenant, not after. If audit.log() throws (a
    // transient audit_log write failure), pauseTenant below never runs, so
    // the tenant stays unpaused and the isTenantPaused guard above cannot
    // suppress a retry: the next evaluator run re-evaluates this org from
    // scratch and attempts both writes together again. Reversing the order
    // would let a successful pause commit while its audit row was still
    // lost, and the guard would then hide that loss on every future run,
    // permanently. The residual risk this ordering accepts is the mirror
    // case (audit succeeds, then pauseTenant itself fails) but that is a
    // bare single-row UPDATE with no constraints to violate, running
    // immediately after a write that just proved the same connection
    // healthy, so it is not a realistic failure mode.
    await audit.log({
      action: 'email.tenant_paused',
      actor: 'system:email_pause_evaluator',
      resource_type: 'organization',
      resource_id: orgId,
      details: {
        reason,
        metric: breach.metric,
        rate: breach.rate,
        total: row.total,
        bounced: row.bounced,
        complained: row.complained,
        window_hours: PAUSE_WINDOW_HOURS,
      },
    })
    await pauseTenant(db, orgId, reason)
  }
}

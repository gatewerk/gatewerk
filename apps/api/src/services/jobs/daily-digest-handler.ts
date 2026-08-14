import { eq } from "drizzle-orm";
import type { AppDb } from "@gatewerk/db";
import { jobsDailyDigestState } from "@gatewerk/db/src/schema/index";
import type { AuditService } from "../audit";
import type { SendEmailInput, SendEmailResult } from "../email/index";
import { computeDailyDigestBatches } from "./daily-digest-predicate";
import { renderDailyDigestEmail } from "./daily-digest-email";
import { resolveTenantOrgId } from "../../jobs/notification-slack-handler";

export type DailyDigestResult =
  | { status: "skipped"; reason: "already_ran_today"; last_run_at: Date }
  | { status: "completed"; dispatched: number; skipped: number; failed: number; total: number };

interface RunOpts {
  /**
   * Test-only seam: throw after dispatches to assert txn-rollback contract.
   * Do not pass from production callers — the underscore prefix denotes this
   * is a test-only seam.
   */
  _testOnly_injectFailureAfterDispatch?: boolean;
}

/**
 * Minimal structural type accepted by the daily-digest handler.
 *
 * The real EmailService (apps/api/src/services/email/index.ts) satisfies
 * this via its `sendEmail(args)` method that returns SendEmailResult. The
 * handler accepts this narrower shape so test doubles can stub it without
 * implementing the full EmailService surface (close/configureGate/etc).
 */
interface DigestEmailService {
  sendEmail(args: SendEmailInput): Promise<SendEmailResult>;
}

type AuditEntry = Parameters<AuditService["log"]>[0];

// Compile-time exhaustiveness guard — adding a new variant becomes a TS error
// at every switch that covers SendOutcome or DailyDigestResult.
function assertNever(x: never): never {
  throw new Error(`Non-exhaustive switch: ${JSON.stringify(x)}`);
}

type SendOutcome =
  | { kind: "sent" }
  | { kind: "skipped_no_config" }
  | { kind: "suppressed" }
  | { kind: "tenant_paused" }
  | { kind: "deduped" }
  | { kind: "failed"; lastError: unknown };

async function sendWithRetry(
  email: DigestEmailService,
  args: SendEmailInput,
  maxAttempts = 3,
): Promise<SendOutcome> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await email.sendEmail(args);
      switch (result.status) {
        case "sent":              return { kind: "sent" };
        case "skipped_no_config": return { kind: "skipped_no_config" };
        case "suppressed":        return { kind: "suppressed" };
        // A paused tenant is a non-error, non-retry outcome like
        // suppression (nothing delivered, retrying would just hit the
        // breaker again) but a DIFFERENT cause: an operator reading
        // skip_reason: "suppressed" would go looking at the per-address
        // suppression table, when the real cause is
        // organizations.email_paused_at. Own kind so the skip group below
        // reports the true reason via the existing skip_reason: outcome.kind
        // mechanism, without inventing a parallel one.
        case "tenant_paused":     return { kind: "tenant_paused" };
        case "deduped":           return { kind: "deduped" };
        case "rate_limited":
          // Rate-limited is a permanent failure within the retry window —
          // the per-email limiter operates on the same window the retry
          // sits in, so retrying would just hit the limiter again.
          return { kind: "failed", lastError: new Error(`rate_limited:${result.reason}`) };
        case "failed":
          // retry-eligible
          lastError = new Error(`send_failed:${result.error}`);
          break;
        default:
          // Compile-time exhaustiveness — see assertNever above.
          assertNever(result);
      }
    } catch (err) {
      // EmailService docstring claims sendEmail NEVER throws; defense-in-depth.
      lastError = err;
    }
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
  return { kind: "failed", lastError };
}

export async function runDailyDigest(
  db: AppDb,
  email: DigestEmailService,
  audit: AuditService,
  now: Date,
  opts: RunOpts = {},
): Promise<DailyDigestResult> {
  // Audit entries are collected inside the txn and replayed AFTER it commits
  // (R2). This avoids the nested-txn problem: audit.log() uses its own
  // db.transaction() with pg_advisory_xact_lock, which opens a pooled
  // connection independent of the outer txn. Calling audit.log() inside the
  // outer txn means audit rows commit independently and survive a rollback.
  // By deferring to after-commit, we ensure: if the outer txn throws,
  // auditEntries is never iterated and no audit rows are persisted.
  const auditEntries: AuditEntry[] = [];

  const result = await db.transaction(async (tx: AppDb) => {
    // Ensure singleton row exists (defense-in-depth — migration 059 seeds
    // it on prod, but the pglite test DB does not run raw SQL migrations).
    // Uses Drizzle's typed query builder so the row shape is consistent
    // across the postgres.js (prod) and pglite (test) drivers — raw
    // `tx.execute(sql...)` returns driver-specific shapes that caused a
    // production TypeError at L2.1 first-deploy.
    await tx
      .insert(jobsDailyDigestState)
      .values({ id: "singleton", last_run_at: new Date(0) })
      .onConflictDoNothing();

    const rows = await tx
      .select()
      .from(jobsDailyDigestState)
      .where(eq(jobsDailyDigestState.id, "singleton"))
      .for("update");

    const state = rows[0];
    if (!state) {
      throw new Error("jobs_daily_digest_state singleton row missing after insert");
    }

    const lastRun = new Date(state.last_run_at);
    const todayKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
    const lastKey = `${lastRun.getUTCFullYear()}-${lastRun.getUTCMonth()}-${lastRun.getUTCDate()}`;
    if (lastKey === todayKey) {
      auditEntries.push({
        action: "daily_digest.skipped_already_ran",
        actor: "system:daily_digest",
        resource_type: "jobs_daily_digest_state",
        details: { last_run_at: lastRun.toISOString() },
      });
      return { status: "skipped" as const, reason: "already_ran_today" as const, last_run_at: lastRun };
    }

    auditEntries.push({
      action: "daily_digest.started",
      actor: "system:daily_digest",
      resource_type: "jobs_daily_digest_state",
      details: { now: now.toISOString() },
    });

    const batches = await computeDailyDigestBatches(tx, now);

    let dispatched = 0;
    let skipped = 0;
    let failed = 0;
    for (const batch of batches) {
      // Render can throw (React Email render is a failure surface). Isolating
      // it per batch keeps one bad render from rolling back the whole txn —
      // a rollback would un-advance last_run_at and make the cron retry the
      // same failing batch on every tick. Skip, record, continue.
      let rendered: Awaited<ReturnType<typeof renderDailyDigestEmail>>;
      try {
        rendered = await renderDailyDigestEmail(batch);
      } catch (err) {
        failed++;
        console.error("[daily-digest] render failed for batch", {
          errorId: "DAILY_DIGEST_RENDER_FAILED",
          reviewerId: batch.reviewer_id,
          error: err,
        });
        auditEntries.push({
          action: "daily_digest.render_failed",
          actor: "system:daily_digest",
          resource_type: "user",
          resource_id: batch.reviewer_id,
          details: { count: batch.count, error: String(err) },
        });
        continue;
      }

      // Resolve the owning organization so this send is opted into the per
      // tenant deliverability breaker (Stage 5a), mirroring the per
      // notification email handler and the notification digest handler.
      // This is the daily digest's OWN send call: passing no organization_id
      // here was Fix 3's bug, since it made the largest volume stream
      // invisible to the breaker while the tenant_paused switch arm below
      // made it read as already covered.
      //
      // The digest is per reviewer, not per review, so there is no review_id
      // to disambiguate from; passing null routes straight to the sole
      // membership fallback, which is exactly the case that fallback exists
      // for. An ambiguous tenant must never drop the digest, so a fail
      // closed { ok: false } still sends, with organization_id left null.
      //
      // Isolated in its own try/catch, same as the render step above: this
      // queries the database on this reviewer's behalf and can throw. Left
      // unguarded, a resolver throw would propagate out of the loop and
      // silently drop every remaining reviewer's digest instead of just this
      // one's, the exact bug already fixed once in
      // notification-digest-handler.ts.
      //
      // This isolates a JavaScript level throw from the resolver, not a
      // genuine transaction aborting database failure. resolveTenantOrgId
      // runs against `tx`, the same transaction as the rest of this loop and
      // the final last_run_at UPDATE below; a real SQL error here (a broken
      // connection, a constraint violation) poisons that transaction, so
      // every later statement in it fails too, including that UPDATE, and
      // the whole runDailyDigest call rejects regardless of this catch.
      let organization_id: string | null;
      try {
        const tenant = await resolveTenantOrgId(tx, { reviewer_id: batch.reviewer_id, review_id: null });
        organization_id = tenant.ok ? tenant.orgId : null;
      } catch (err) {
        failed++;
        console.error("[daily-digest] tenant resolution failed for batch", {
          errorId: "DAILY_DIGEST_RESOLVE_FAILED",
          reviewerId: batch.reviewer_id,
          error: err,
        });
        auditEntries.push({
          action: "daily_digest.send_failed",
          actor: "system:daily_digest",
          resource_type: "user",
          resource_id: batch.reviewer_id,
          details: { count: batch.count, error: String(err) },
        });
        continue;
      }

      const outcome = await sendWithRetry(email, {
        to: batch.email,
        ...rendered,
        is_transactional: false,
        organization_id,
      });
      switch (outcome.kind) {
        case "sent":
        case "deduped":
          dispatched++;
          auditEntries.push({
            action: "daily_digest.send_succeeded",
            actor: "system:daily_digest",
            resource_type: "user",
            resource_id: batch.reviewer_id,
            details: { count: batch.count, sample_review_ids: batch.sample_review_ids, kind: outcome.kind },
          });
          break;
        case "skipped_no_config":
        case "suppressed":
        case "tenant_paused":
          // All three outcomes mean no email was delivered for this
          // recipient. Count as skipped — the cron should not retry on the
          // next tick; each cause is operator or breaker managed and
          // cleared independently. skip_reason: outcome.kind below already
          // distinguishes them, so "suppressed" and "tenant_paused" don't
          // read as the same event.
          skipped++;
          auditEntries.push({
            action: "daily_digest.send_skipped_no_config",
            actor: "system:daily_digest",
            resource_type: "user",
            resource_id: batch.reviewer_id,
            details: { count: batch.count, sample_review_ids: batch.sample_review_ids, skip_reason: outcome.kind },
          });
          break;
        case "failed":
          failed++;
          auditEntries.push({
            action: "daily_digest.send_failed",
            actor: "system:daily_digest",
            resource_type: "user",
            resource_id: batch.reviewer_id,
            details: { count: batch.count, error: String(outcome.lastError) },
          });
          break;
        default:
          assertNever(outcome);
      }
    }

    if (opts._testOnly_injectFailureAfterDispatch) {
      throw new Error("test-injected failure after dispatch");
    }

    await tx
      .update(jobsDailyDigestState)
      .set({ last_run_at: now })
      .where(eq(jobsDailyDigestState.id, "singleton"));

    auditEntries.push({
      action: "daily_digest.completed",
      actor: "system:daily_digest",
      resource_type: "jobs_daily_digest_state",
      details: { dispatched, skipped, failed, total: batches.length },
    });

    return { status: "completed" as const, dispatched, skipped, failed, total: batches.length };
  });

  // Replay audit entries AFTER the outer txn commits (R2 — nested-txn bypass
  // remediation). Failures are best-effort and must not prevent the caller
  // from receiving the completed result.
  for (const entry of auditEntries) {
    await audit.log(entry).catch(err => {
      console.warn("[daily-digest] audit_log_failed", entry.action, err);
    });
  }

  return result;
}

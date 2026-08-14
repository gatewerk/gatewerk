import { eq } from "drizzle-orm";
import type { AppDb } from "@gatewerk/db";
import { jobsNotificationDigestState } from "@gatewerk/db/src/schema/index";
import type { AuditService } from "../audit";
import type { SendEmailInput, SendEmailResult } from "../email/index";
import { computeNotificationDigestBatches } from "./notification-digest-predicate";
import { renderNotificationDigestEmail } from "./notification-digest-email";
import { generateEmailToken } from "../../lib/email-tokens";
import { config } from "../../config";
import { resolveTenantOrgId } from "../../jobs/notification-slack-handler";

export type NotificationDigestResult =
  | { status: "skipped"; reason: "already_ran_today"; last_run_at: Date }
  | { status: "completed"; dispatched: number; skipped: number; failed: number; total: number };

/**
 * Minimal structural type accepted by the notification-digest handler.
 *
 * The real EmailService satisfies this via its `sendEmail(args)` method.
 * The handler accepts this narrower shape so test doubles can stub it
 * without implementing the full EmailService surface.
 */
interface DigestEmailService {
  sendEmail(args: SendEmailInput): Promise<SendEmailResult>;
}

type AuditEntry = Parameters<AuditService["log"]>[0];

// Compile-time exhaustiveness guard.
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

/**
 * Daily notification digest job handler.
 *
 * For each opted-in reviewer who has at least one unread notification, mints
 * a 30-day unsubscribe token, renders the NotificationDigestEmail template,
 * and dispatches via the email service with `is_transactional: false` and a
 * `listUnsubscribeUrl` so mail clients surface the one-click unsubscribe.
 *
 * Idempotent: the `jobs_notification_digest_state` singleton row is locked
 * via SELECT FOR UPDATE and last_run_at is advanced inside the transaction.
 * A second call with the same calendar day (UTC) returns `{ status: "skipped" }`.
 */
export async function runNotificationDigest(
  db: AppDb,
  email: DigestEmailService,
  audit: AuditService,
  now: Date,
): Promise<NotificationDigestResult> {
  // Audit entries collected inside the txn and replayed after commit (avoids
  // the nested-txn / pooled-connection problem; mirrors runDailyDigest).
  const auditEntries: AuditEntry[] = [];

  const result = await db.transaction(async (tx: AppDb) => {
    // Ensure singleton row exists. The pglite test DB does not run raw SQL
    // migrations, so we insert defensively. Idempotent on conflict.
    await tx
      .insert(jobsNotificationDigestState)
      .values({ id: "singleton", last_run_at: new Date(0) })
      .onConflictDoNothing();

    const rows = await tx
      .select()
      .from(jobsNotificationDigestState)
      .where(eq(jobsNotificationDigestState.id, "singleton"))
      .for("update");

    const state = rows[0];
    if (!state) {
      throw new Error("jobs_notification_digest_state singleton row missing after insert");
    }

    const lastRun = new Date(state.last_run_at);
    const todayKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
    const lastKey = `${lastRun.getUTCFullYear()}-${lastRun.getUTCMonth()}-${lastRun.getUTCDate()}`;
    if (lastKey === todayKey) {
      auditEntries.push({
        action: "notification_digest.skipped_already_ran",
        actor: "system:notification_digest",
        resource_type: "jobs_notification_digest_state",
        details: { last_run_at: lastRun.toISOString() },
      });
      return { status: "skipped" as const, reason: "already_ran_today" as const, last_run_at: lastRun };
    }

    auditEntries.push({
      action: "notification_digest.started",
      actor: "system:notification_digest",
      resource_type: "jobs_notification_digest_state",
      details: { now: now.toISOString() },
    });

    const batches = await computeNotificationDigestBatches(tx);

    let dispatched = 0;
    let skipped = 0;
    let failed = 0;

    for (const batch of batches) {
      // Render can throw (React Email render is a failure surface). Isolating
      // per batch keeps one bad render from rolling back the whole txn.
      let rendered: Awaited<ReturnType<typeof renderNotificationDigestEmail>>;
      const token = generateEmailToken(
        { reviewer_id: batch.reviewer_id, email: batch.email, purpose: "digest_unsubscribe" },
        30 * 24 * 60 * 60 * 1000,
      );
      const unsubscribeUrl = `${config.apiOrigin}/api/v1/unsub/${token}`;

      try {
        rendered = await renderNotificationDigestEmail({
          count: batch.unread_count,
          sampleTitles: batch.sample_titles,
          unsubscribeUrl,
        });
      } catch (err) {
        failed++;
        console.error("[notification-digest] render failed for batch", {
          errorId: "NOTIFICATION_DIGEST_RENDER_FAILED",
          reviewerId: batch.reviewer_id,
          error: err,
        });
        auditEntries.push({
          action: "notification_digest.render_failed",
          actor: "system:notification_digest",
          resource_type: "user",
          resource_id: batch.reviewer_id,
          details: { unread_count: batch.unread_count, error: String(err) },
        });
        continue;
      }

      // Opt this send into the per-tenant deliverability breaker (Stage 5a),
      // mirroring the per-notification email handler. The digest is per
      // reviewer rather than per review, so there is no review_id to resolve
      // from; passing null routes straight to the sole-membership fallback,
      // which is exactly the case that fallback exists for. An ambiguous
      // tenant must never drop the digest: organization_id simply stays
      // null, so the breaker does not apply to this send.
      //
      // Isolated in its own try/catch, same as the render step above: this
      // queries the database on this reviewer's behalf and can throw. Left
      // unguarded, a resolver throw would propagate out of the loop and
      // silently drop every remaining reviewer's digest instead of just this
      // one's.
      //
      // This isolates a JavaScript level throw from the resolver, not a
      // genuine transaction aborting database failure. resolveTenantOrgId
      // runs against `tx`, the same transaction as the rest of this loop and
      // the final last_run_at UPDATE below; a real SQL error here (a broken
      // connection, a constraint violation) poisons that transaction, so
      // every later statement in it fails too, including that UPDATE, and
      // the whole runNotificationDigest call rejects regardless of this
      // catch.
      let organization_id: string | null;
      try {
        const tenant = await resolveTenantOrgId(tx, { reviewer_id: batch.reviewer_id, review_id: null });
        organization_id = tenant.ok ? tenant.orgId : null;
      } catch (err) {
        failed++;
        console.error("[notification-digest] tenant resolution failed for batch", {
          errorId: "NOTIFICATION_DIGEST_RESOLVE_FAILED",
          reviewerId: batch.reviewer_id,
          error: err,
        });
        auditEntries.push({
          action: "notification_digest.send_failed",
          actor: "system:notification_digest",
          resource_type: "user",
          resource_id: batch.reviewer_id,
          details: { unread_count: batch.unread_count, error: String(err) },
        });
        continue;
      }

      const outcome = await sendWithRetry(email, {
        to: batch.email,
        ...rendered,
        is_transactional: false,
        listUnsubscribeUrl: unsubscribeUrl,
        organization_id,
      });

      switch (outcome.kind) {
        case "sent":
        case "deduped":
          dispatched++;
          auditEntries.push({
            action: "notification_digest.send_succeeded",
            actor: "system:notification_digest",
            resource_type: "user",
            resource_id: batch.reviewer_id,
            details: { unread_count: batch.unread_count, kind: outcome.kind },
          });
          break;
        case "skipped_no_config":
        case "suppressed":
        case "tenant_paused":
          // skip_reason: outcome.kind below already distinguishes these, so
          // "suppressed" and "tenant_paused" don't read as the same event.
          skipped++;
          auditEntries.push({
            action: "notification_digest.send_skipped",
            actor: "system:notification_digest",
            resource_type: "user",
            resource_id: batch.reviewer_id,
            details: { unread_count: batch.unread_count, skip_reason: outcome.kind },
          });
          break;
        case "failed":
          failed++;
          auditEntries.push({
            action: "notification_digest.send_failed",
            actor: "system:notification_digest",
            resource_type: "user",
            resource_id: batch.reviewer_id,
            details: { unread_count: batch.unread_count, error: String(outcome.lastError) },
          });
          break;
        default:
          assertNever(outcome);
      }
    }

    await tx
      .update(jobsNotificationDigestState)
      .set({ last_run_at: now })
      .where(eq(jobsNotificationDigestState.id, "singleton"));

    auditEntries.push({
      action: "notification_digest.completed",
      actor: "system:notification_digest",
      resource_type: "jobs_notification_digest_state",
      details: { dispatched, skipped, failed, total: batches.length },
    });

    return { status: "completed" as const, dispatched, skipped, failed, total: batches.length };
  });

  // Replay audit entries after the txn commits (avoids nested-txn issue).
  for (const entry of auditEntries) {
    await audit.log(entry).catch(err => {
      console.warn("[notification-digest] audit_log_failed", entry.action, err);
    });
  }

  return result;
}

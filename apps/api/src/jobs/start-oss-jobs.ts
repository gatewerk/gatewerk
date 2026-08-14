import type { Express } from "express";
import type { AppDb } from "@gatewerk/db";
import type { EmailService } from "../services/email/index";
import type { AuditService } from "../services/audit";
import { getPgBoss, stopPgBoss } from "../services/jobs/pg-boss-client";
import { runDailyDigest } from "../services/jobs/daily-digest-handler";
import { runNotificationDigest } from "../services/jobs/notification-digest-handler";
import { handleNotificationEmail, type NotificationEmailJob } from "./notification-email-handler";
import { handleNotificationSlack, type NotificationSlackJob } from "./notification-slack-handler";
import { usersLookupByEmail, postMessage } from "../lib/slack-client";
import { evaluateEmailPause } from "./email-pause-evaluator";

/**
 * Durably record a notification-delivery failure.
 *
 * The two highest-volume queues deliberately isolate per-job errors so a
 * single bad job cannot cause pg-boss to retry the whole batch and re-send
 * mail that already succeeded. That posture is right, but it previously meant
 * a failure reached the operator only as a console line and was recorded
 * nowhere durable. `notification.failed` was already declared in AUDIT_ACTIONS
 * with zero emit sites; this is the emit site.
 *
 * Deliberately logs `notification_id` and NOT the recipient address: these
 * jobs carry no project_id, so the row lands in the shared NULL "system"
 * partition, which is readable across tenants via the `project_id IS NULL`
 * clause in audit.query(). An opaque id is correlatable by an operator
 * without putting an email address in a cross-tenant-visible row.
 */
async function recordNotificationFailure(
  audit: AuditService,
  channel: "email" | "slack",
  notificationId: string,
  error: string,
): Promise<void> {
  await audit.log({
    action: "notification.failed",
    actor: `system:notification_${channel}`,
    resource_type: "notification",
    resource_id: notificationId,
    details: { channel, error },
  }).catch((auditErr) => {
    console.error("[notification] failed to record delivery failure", { notificationId, auditErr });
  });
}

// OSS-side pg-boss bootstrap. Tolerant of test/no-DB environments — pg-boss
// requires a real Postgres connection, and integration tests that boot
// createApp against pglite must not fail-closed here.
export async function startOssJobs(app: Express, db: AppDb): Promise<void> {
  const email = (app as any).emailService as EmailService | undefined;
  const audit = (app as any).auditService as AuditService | undefined;
  if (!email || !audit) {
    console.warn("startOssJobs: email or audit service missing on app, skipping daily-digest bootstrap");
    return;
  }

  // Compile-time exhaustiveness guard.
  function assertNever(x: never): never {
    throw new Error(`Non-exhaustive switch: ${JSON.stringify(x)}`);
  }

  try {
    const boss = await getPgBoss();

    // pg-boss v10+ requires explicit queue creation before schedule/work.
    // Only boss.send() auto-creates queues; boss.schedule() and boss.work()
    // throw "Queue not found" without a prior createQueue. Idempotent (no-op
    // if the queue row already exists in pgboss.queue).
    await boss.createQueue("oss.daily-digest");

    // Daily-digest schedule — 9am UTC every day. pg-boss schedule upsert is
    // idempotent so this re-runs cleanly on every boot.
    await boss.schedule("oss.daily-digest", "0 9 * * *");

    await boss.work("oss.daily-digest", async () => {
      try {
        const result = await runDailyDigest(db, email, audit, new Date());
        // Propagate the result so pg-boss's completion log captures the handler outcome.
        switch (result.status) {
          case "skipped":
            console.log("[daily-digest] skipped (already ran today)");
            return result;
          case "completed":
            console.log(
              `[daily-digest] completed (dispatched=${result.dispatched}, skipped=${result.skipped}, failed=${result.failed}, total=${result.total})`,
            );
            return result;
          default:
            // Compile-time exhaustiveness — adding a new variant becomes a TS error here.
            assertNever(result);
        }
      } catch (err) {
        console.error("[daily-digest] unhandled error", err);
        await audit.log({
          action: "daily_digest.unhandled_error",
          actor: "system:daily_digest",
          resource_type: "jobs_daily_digest_state",
          details: { error: err instanceof Error ? err.message : String(err) },
        }).catch(() => {});
        throw err; // re-throw so pg-boss retries
      }
    });

    await boss.createQueue("oss.notification-email");
    await boss.work<NotificationEmailJob>("oss.notification-email", async (jobs) => {
      // Per-job error isolation: a throw here (render error, transient DB error)
      // must NOT reject the batch — pg-boss would retry the ENTIRE batch and
      // re-send emails for jobs that already succeeded earlier in the loop.
      // A dropped best-effort email is acceptable (the in-app inbox is the
      // reliable channel); avoiding double-sends on retry is the priority.
      // (Distinct from oss.daily-digest, which rethrows to trigger retry.)
      for (const job of jobs) {
        try {
          const result = await handleNotificationEmail({ db, email }, job.data);
          // sendEmail never throws, so a delivery failure arrives here as a
          // union member rather than an exception. Without this branch a
          // broken SMTP config was invisible: no throw, no log, no record.
          if (result && result.status === "failed") {
            await recordNotificationFailure(audit, "email", job.data.notificationId, result.error);
          }
        } catch (err) {
          console.error(
            `[notification-email] job ${job.id} failed (skipping, no retry)`,
            err instanceof Error ? err.message : err,
          );
          await recordNotificationFailure(
            audit, "email", job.data.notificationId,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    });

    await boss.createQueue("oss.notification-slack");
    await boss.work<NotificationSlackJob>("oss.notification-slack", async (jobs) => {
      // Per-job error isolation: a Slack DM failure (rate limit, revoked token,
      // network error) must NOT reject the batch. Slack delivery is best-effort;
      // the in-app inbox is the reliable floor. No retry — same posture as
      // oss.notification-email.
      const slack = { usersLookupByEmail, postMessage };
      for (const job of jobs) {
        try {
          await handleNotificationSlack({ db, slack }, job.data);
        } catch (err) {
          console.error(
            `[notification-slack] job ${job.id} failed (skipping, no retry)`,
            err instanceof Error ? err.message : err,
          );
          await recordNotificationFailure(
            audit, "slack", job.data.notificationId,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    });

    await boss.createQueue("oss.notification-digest");
    await boss.schedule("oss.notification-digest", "0 9 * * *");
    await boss.work("oss.notification-digest", async () => {
      try {
        const result = await runNotificationDigest(db, email, audit, new Date());
        switch (result.status) {
          case "skipped":
            console.log("[notification-digest] skipped (already ran today)");
            return result;
          case "completed":
            console.log(
              `[notification-digest] completed (dispatched=${result.dispatched}, skipped=${result.skipped}, failed=${result.failed}, total=${result.total})`,
            );
            return result;
          default:
            assertNever(result);
        }
      } catch (err) {
        console.error("[notification-digest] unhandled error", err);
        await audit.log({
          action: "notification_digest.unhandled_error",
          actor: "system:notification_digest",
          resource_type: "jobs_notification_digest_state",
          details: { error: err instanceof Error ? err.message : String(err) },
        }).catch(() => {});
        throw err; // re-throw so pg-boss retries
      }
    });

    await boss.createQueue("oss.email-pause-evaluate");
    await boss.schedule("oss.email-pause-evaluate", "0 * * * *");
    await boss.work("oss.email-pause-evaluate", async () => {
      try {
        await evaluateEmailPause(db, audit);
        console.log("[email-pause-evaluate] completed");
      } catch (err) {
        console.error("[email-pause-evaluate] unhandled error", err);
        throw err; // re-throw so pg-boss retries
      }
    });

    (app as any).stopPgBoss = stopPgBoss;
    (app as any).ossJobsStatus = { ok: true, startedAt: new Date() };
    console.log("OSS pg-boss workers registered (oss.daily-digest @ 0 9 * * *, oss.notification-email, oss.notification-slack, oss.notification-digest @ 0 9 * * *, oss.email-pause-evaluate @ 0 * * * *)");
  } catch (err) {
    // A test environment without a real DB lands here and that is expected.
    // Production landing here means the API is running with NO background
    // workers at all: no timeouts fire, no notifications send, no digests run.
    // The reachable production causes are real — a DB role without rights to
    // CREATE SCHEMA pgboss, or a pg-boss migration failure.
    //
    // This used to console.warn "likely test env without real DB"
    // unconditionally, which told an operator whose deployment was silently
    // gutted that everything was probably fine. The status is recorded on
    // the app so GET /health/ready can answer the question instead of the
    // operator having to find a log line.
    const message = err instanceof Error ? err.message : String(err);
    (app as any).ossJobsStatus = { ok: false, error: message };

    const isTestEnv = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    if (isTestEnv) {
      console.warn("startOssJobs: pg-boss bootstrap skipped (test env without a real DB):", message);
    } else {
      console.error(
        "startOssJobs: pg-boss bootstrap FAILED. The API is running with NO background workers — " +
        "review timeouts will not fire, notifications will not send, digests will not run. " +
        "Check that the database role may CREATE SCHEMA pgboss.",
        message,
      );
    }
  }
}

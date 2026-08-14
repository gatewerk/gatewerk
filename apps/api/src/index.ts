// Side-effect import: t3-env validates the env contract at boot.
// In production, missing required vars throw here — before any route
// handles requests. In test, skipValidation short-circuits this.
import "./env";
import { createApp, mountEeIfCloud } from "./app";
import { config, validateProductionConfig } from "./config";
import { createDb } from "@gatewerk/db";

// config.ts already fail-closes at module init when required envs are
// unset. This call adds defense-in-depth against the case where an
// operator explicitly sets HMAC_SECRET/JWT_SECRET to one of the historical
// "dev-secret"/"dev-jwt-secret" sentinels — an actual non-empty env value
// that requireEnv would otherwise accept. Skipped under the test path so
// deterministic test fallbacks don't trip the sentinel check.
if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
  validateProductionConfig();
}

if (config.mode === "cloud") {
  const sentryPath = (): string => new URL("../../../ee/api/monitoring/sentry.js", import.meta.url).href;
  import(sentryPath()).then((m: { initSentry: () => void }) => m.initSentry()).catch(() => {});
}

// Last-resort crash visibility. Sentry lives in ee/ and is absent from OSS
// builds, so a self-hosted deployment otherwise has no error-reporting path
// at all: an unhandled rejection would terminate the process (Node >= 15)
// with nothing written anywhere the operator looks. These handlers are
// deliberately in OSS core and depend on nothing beyond console.
//
// They log and re-raise rather than swallow: suppressing a crash would leave
// the process alive in an unknown state, which is worse than restarting under
// a supervisor.
process.on("unhandledRejection", (reason) => {
  console.error("FATAL: unhandled promise rejection", {
    reason: reason instanceof Error ? { name: reason.name, message: reason.message, stack: reason.stack } : reason,
  });
  throw reason;
});

process.on("uncaughtException", (err) => {
  console.error("FATAL: uncaught exception", { name: err.name, message: err.message, stack: err.stack });
  process.exit(1);
});

async function main(): Promise<void> {
  const db = createDb(config.databaseUrl);
  const app = createApp({ db });

  // Cloud-tier bootstrap gate. No-op in standalone mode.
  await mountEeIfCloud(app);

  // OSS-side pg-boss workers — daily-digest cron + future OSS jobs. Runs
  // in both standalone and cloud modes. Cloud mode also registers EE jobs
  // via mountEeIfCloud above; both share the singleton pg-boss client.
  const { startOssJobs } = await import("./jobs/start-oss-jobs");
  await startOssJobs(app, db);

  const server = app.listen(config.port, () => {
    console.log(`Gatewerk API running on port ${config.port} (mode: ${config.mode})`);

    // Start timeout worker (check every 30 seconds)
    const worker = (app as any).timeoutWorker;
    if (worker) {
      worker.start(30_000);
      console.log("Timeout worker started (30s interval)");
    }

    // Start chain crash-reconciliation sweep (every 60 seconds).
    // Finds active steps whose review is already terminal and re-drives the
    // existing idempotent handlers; guards against in-process EventBus loss.
    const chainEngine = (app as any).chainEngine;
    if (chainEngine) {
      chainEngine.start(60_000);
      console.log("Chain reconcile worker started (60s interval)");
    }

    // Start webhook retry worker (check every 10 seconds)
    const retryWorker = (app as any).webhookRetryWorker;
    if (retryWorker) {
      retryWorker.start(10_000);
      console.log("Webhook retry worker started (10s interval)");
    }

    // Start api_key_usage cleanup worker (once per day, 30-day retention)
    const usageCleanup = (app as any).apiKeyUsageCleanup;
    if (usageCleanup) {
      usageCleanup.start();
      console.log("API key usage cleanup worker started (24h interval, 30-day retention)");
    }

    // Start note-attachment orphan GC worker (once per day, third defense
    // layer for cascade contract per Phase A spec §11.7 / AC #15)
    const noteCleanup = (app as any).noteCleanupWorker;
    if (noteCleanup) {
      noteCleanup.start();
      console.log("Note cleanup worker started (24h interval, sweeps orphaned note_attachments)");
    }
  });

  // Slowloris defense: cap time to receive complete request headers.
  // Not setting requestTimeout — SSE connections are long-lived by design.
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 72_000;

  // Graceful shutdown — close the nodemailer SMTP pool on SIGTERM/SIGINT
  // so the pooled connections drain rather than abort mid-send. The email
  // service is instantiated even when no route currently consumes it so
  // SIGTERM coverage is in place when the first consumer lands.
  //
  // Only the email pool needs explicit close — the workers above are
  // interval-based and Node tears them down via process exit. A future
  // hardening pass can stop workers explicitly and await in-flight
  // requests before exiting; that's a separate initiative.
  async function shutdown(signal: "SIGTERM" | "SIGINT"): Promise<void> {
    console.log("%s received, closing email pool", signal);
    const emailService = (app as any).emailService;
    if (emailService) {
      try {
        await emailService.close();
      } catch (err) {
        console.error("Error closing email service on %s", signal, err);
      }
    }
    const chainEngineShutdown = (app as any).chainEngine;
    if (chainEngineShutdown) chainEngineShutdown.stop();
    process.exit(0);
  }
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

main().catch((err) => {
  console.error("FATAL: API boot failed", err);
  process.exit(1);
});

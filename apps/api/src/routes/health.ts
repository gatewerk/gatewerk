import { Router, type Express } from "express";
import { sql } from "drizzle-orm";
import type { AppDb } from "@gatewerk/db";

/**
 * Readiness surface.
 *
 * `GET /health` stays what it was — a static 200 liveness probe. It is wired
 * into four compose healthchecks, the tagged-release deploy gate, nginx and
 * quickstart, and making it touch the database would turn a transient DB blip
 * into a container restart loop. Liveness answers "is this process up", and
 * that is genuinely all it should answer.
 *
 * `GET /health/ready` answers the different question: is this deployment
 * actually doing its job. Before this existed there was no way to ask. A
 * self-hosted Gatewerk whose entire background-job layer failed to start still
 * reported healthy — no timeouts firing, no notifications sending, no digests
 * running — because /health returns an object literal and checks nothing.
 * That matters more here than in most products: "nothing hangs forever" is one
 * of the four things Gatewerk claims, and the timeout worker is what makes it
 * true.
 *
 * Unauthenticated, like /health, and deliberately free of anything sensitive:
 * component names, booleans, a stale-tick age, and an error MESSAGE only for
 * the job bootstrap (which is operator-caused config, not user data).
 */

type ComponentStatus = {
  ok: boolean;
  detail?: string;
};

/**
 * A worker is late when it has not ticked for this many multiples of its own
 * interval. Two allows one missed tick plus scheduling jitter before an
 * operator is told something is wrong; one would flap on a slow tick.
 */
const LATE_TICK_MULTIPLIER = 3;

/** Floor for the staleness window, for workers on very short intervals. */
const MIN_LATE_TICK_MS = 90_000;

export function createHealthRoutes(app: Express, db?: AppDb): Router {
  const router = Router();

  router.get("/ready", async (_req, res) => {
    const checks: Record<string, ComponentStatus> = {};

    // --- database -----------------------------------------------------------
    if (!db) {
      checks.database = { ok: false, detail: "no database handle configured" };
    } else {
      try {
        await db.execute(sql`SELECT 1`);
        checks.database = { ok: true };
      } catch (err) {
        checks.database = {
          ok: false,
          detail: err instanceof Error ? err.message : "query failed",
        };
      }
    }

    // --- background jobs ----------------------------------------------------
    // startOssJobs records its outcome here. Undefined means it has not run
    // yet (still booting) rather than that it failed.
    const jobs = (app as any).ossJobsStatus as
      | { ok: true; startedAt: Date }
      | { ok: false; error: string }
      | undefined;
    if (jobs === undefined) {
      checks.background_jobs = { ok: false, detail: "not started yet" };
    } else if (jobs.ok) {
      checks.background_jobs = { ok: true };
    } else {
      checks.background_jobs = { ok: false, detail: jobs.error };
    }

    // --- timeout worker -----------------------------------------------------
    // The worker that closes out unattended reviews. A stale lastTickAt means
    // the loop stopped; a non-null lastTickError means it is running and
    // failing. They are different faults and an operator needs to tell them
    // apart, so they report differently.
    const worker = (app as any).timeoutWorker as
      | { lastTickAt: Date | null; lastTickError: string | null; tickIntervalMs: number | null }
      | undefined;
    if (!worker) {
      checks.timeout_worker = { ok: false, detail: "not constructed" };
    } else if (worker.tickIntervalMs === null) {
      // Constructed but never started. True in tests and in any embedding that
      // drives tick() by hand, so it is not an error.
      checks.timeout_worker = { ok: true, detail: "not started" };
    } else if (worker.lastTickError) {
      checks.timeout_worker = { ok: false, detail: `last tick failed: ${worker.lastTickError}` };
    } else if (worker.lastTickAt === null) {
      checks.timeout_worker = { ok: false, detail: "started but has not completed a tick" };
    } else {
      const ageMs = Date.now() - worker.lastTickAt.getTime();
      const limit = Math.max(worker.tickIntervalMs * LATE_TICK_MULTIPLIER, MIN_LATE_TICK_MS);
      checks.timeout_worker = ageMs > limit
        ? { ok: false, detail: `last tick ${Math.round(ageMs / 1000)}s ago` }
        : { ok: true, detail: `last tick ${Math.round(ageMs / 1000)}s ago` };
    }

    const ok = Object.values(checks).every((c) => c.ok);
    // 503 so an orchestrator or uptime monitor can act on it without parsing
    // the body. /health remains the liveness probe; this is readiness.
    res.status(ok ? 200 : 503).json({
      status: ok ? "ready" : "degraded",
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

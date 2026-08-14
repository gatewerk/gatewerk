/**
 * GET /health/ready — the readiness surface.
 *
 * The gap it closes: a self-hosted deployment whose entire background-job layer
 * failed to start still reported healthy, because GET /health returns a static
 * object literal and checks nothing. No timeouts firing, no notifications
 * sending, no digests running, and the only trace was a console.warn that said
 * the failure was "likely test env without real DB".
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../app";
import { createTestDb } from "./helpers/test-db";

describe("GET /health/ready", () => {
  let app: Express;
  let db: any;

  beforeAll(async () => {
    const setup = await createTestDb();
    db = setup.db;
    app = createApp({ db });
  });

  it("keeps /health a static liveness probe", async () => {
    // Four compose healthchecks and the release deploy gate poll this. It must
    // not start failing on DB or worker state.
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("reports degraded when the background-job layer never started", async () => {
    // startOssJobs has not run in this test app, so ossJobsStatus is undefined.
    // That is exactly the shape a production deployment has when pg-boss
    // bootstrap failed and the API booted anyway.
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.checks.background_jobs.ok).toBe(false);

    // The database IS reachable here, so readiness must distinguish the two
    // rather than collapsing to a single boolean an operator cannot act on.
    expect(res.body.checks.database.ok).toBe(true);
  });

  it("surfaces the bootstrap error message so the operator can act on it", async () => {
    (app as any).ossJobsStatus = {
      ok: false,
      error: 'permission denied for schema pgboss',
    };
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks.background_jobs.detail).toContain("pgboss");
  });

  it("reports ready once the job layer is up and the worker is healthy", async () => {
    (app as any).ossJobsStatus = { ok: true, startedAt: new Date() };
    (app as any).timeoutWorker = {
      lastTickAt: new Date(),
      lastTickError: null,
      tickIntervalMs: 30_000,
    };

    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.checks.timeout_worker.ok).toBe(true);
  });

  it("reports degraded when the timeout worker is running but failing", async () => {
    (app as any).ossJobsStatus = { ok: true, startedAt: new Date() };
    (app as any).timeoutWorker = {
      lastTickAt: new Date(),
      lastTickError: "connection terminated unexpectedly",
      tickIntervalMs: 30_000,
    };

    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks.timeout_worker.ok).toBe(false);
    expect(res.body.checks.timeout_worker.detail).toContain("connection terminated");
  });

  it("reports degraded when the timeout worker has stopped ticking", async () => {
    // A stalled loop and a failing loop are different faults. This one has no
    // error — it simply is not running any more, which is the harder case to
    // notice and the one that makes "nothing hangs forever" quietly false.
    (app as any).ossJobsStatus = { ok: true, startedAt: new Date() };
    (app as any).timeoutWorker = {
      lastTickAt: new Date(Date.now() - 30 * 60_000),
      lastTickError: null,
      tickIntervalMs: 30_000,
    };

    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks.timeout_worker.ok).toBe(false);
    expect(res.body.checks.timeout_worker.detail).toMatch(/last tick \d+s ago/);
  });
});

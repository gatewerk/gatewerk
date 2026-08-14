import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../../app";
import { createTestDb, seedTestProject, seedReviewer } from "../../../__tests__/helpers/test-db";

// Lightweight audit stub: avoids nested db.transaction() calls.
// PGlite (single-connection) deadlocks when a second db.transaction() is
// opened inside a running db.transaction() — the real auditService does
// exactly that for the HMAC-chain advisory lock pattern. The stub satisfies
// the DigestEmailService shape that runDailyDigest accepts.
function makeAuditService(): any {
  return { log: vi.fn(async () => {}) };
}

describe("POST /api/v1/admin/jobs/daily-digest/run", () => {
  let app: any;
  let client: any;
  let db: any;
  let adminToken: string;
  let reviewerToken: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;
    await seedTestProject(db);
    app = createApp({ db, auditService: makeAuditService() as any });

    const admin = await seedReviewer(db, app, {
      email: "admin-jobs@test.local",
      password: "password123",
      role: "admin",
    });
    adminToken = admin.sessionToken;

    const reviewer = await seedReviewer(db, app, {
      email: "reviewer-jobs@test.local",
      password: "password123",
      role: "reviewer",
    });
    reviewerToken = reviewer.sessionToken;
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).post("/api/v1/admin/jobs/daily-digest/run");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin role", async () => {
    const res = await request(app)
      .post("/api/v1/admin/jobs/daily-digest/run")
      .set("Authorization", `Bearer ${reviewerToken}`);
    expect(res.status).toBe(403);
  });

  it("returns 200 with status:completed (or skipped) on admin call", async () => {
    const res = await request(app)
      .post("/api/v1/admin/jobs/daily-digest/run")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(["completed", "skipped"]).toContain(res.body.status);
  });

  it("returns status:skipped on same-day second call", async () => {
    const res = await request(app)
      .post("/api/v1/admin/jobs/daily-digest/run")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("skipped");
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviewers, auditLog, projects } from "@gatewerk/db/src/schema/index";
import { createAuditService } from "../services/audit";
import { generateId } from "@gatewerk/shared";
import jwt from "jsonwebtoken";
import { config } from "../config";

// Regression for hmac-secret exposure on read.
// `GET /api/v1/settings/hmac-secret` used to return
// the full plaintext secret on every admin call with no audit trail.
// The redesign splits the surface:
//   - GET returns `{ prefix, has_secret }` only (no audit entry; safe metadata).
//   - POST /reveal returns the full secret AND emits `hmac_secret.revealed`.
//   - POST /rotate returns the new secret AND emits `hmac_secret.rotated`.
// This test pins each of those invariants so a future edit that restores the
// old "GET → plaintext" shape fails loudly.
describe("HMAC secret surface (regression: F2)", () => {
  let app: any;
  let testDb: any;
  let adminToken: string;
  let reviewerToken: string;
  let projectId: string;
  let originalSecret: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    testDb = db;

    const auditService = createAuditService(db);
    app = createApp({ db });

    const seed = await seedTestProject(db);
    projectId = seed.project.id;

    const [projRow] = await db
      .select({ hmac_secret: projects.hmac_secret })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    originalSecret = projRow.hmac_secret;

    const adminReviewerId = generateId("user");
    await db.insert(reviewers).values({
      id: adminReviewerId,
      email: "hmac-admin@test.local",
      name: "HMAC Admin",
      password_hash: "unused-in-jwt-test",
      role: "admin",
      is_active: true,
    });
    adminToken = jwt.sign({ sub: adminReviewerId, email: "hmac-admin@test.local" }, config.jwtSecret, { audience: "gatewerk-dashboard", issuer: "gatewerk-api" });

    const reviewerReviewerId = generateId("user");
    await db.insert(reviewers).values({
      id: reviewerReviewerId,
      email: "hmac-reviewer@test.local",
      name: "HMAC Reviewer",
      password_hash: "unused-in-jwt-test",
      role: "reviewer",
      is_active: true,
    });
    reviewerToken = jwt.sign({ sub: reviewerReviewerId, email: "hmac-reviewer@test.local" }, config.jwtSecret, { audience: "gatewerk-dashboard", issuer: "gatewerk-api" });

    // Hold reference so the unused-var check doesn't prune it; audit entries are
    // written by the route handlers via the service wired into createApp.
    void auditService;
  });

  it("GET /hmac-secret returns preview only (prefix + has_secret, never the full plaintext)", async () => {
    const res = await request(app)
      .get("/api/v1/settings/hmac-secret")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.prefix).toBe(originalSecret.slice(0, 8));
    expect(res.body.has_secret).toBe(true);
    expect(res.body.hmac_secret).toBeUndefined();
  });

  it("GET /hmac-secret is admin-only (403 for reviewer role)", async () => {
    const res = await request(app)
      .get("/api/v1/settings/hmac-secret")
      .set("Authorization", `Bearer ${reviewerToken}`);
    expect(res.status).toBe(403);
  });

  it("POST /hmac-secret/reveal returns the full secret for admin", async () => {
    const res = await request(app)
      .post("/api/v1/settings/hmac-secret/reveal")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.hmac_secret).toBe(originalSecret);
  });

  it("POST /hmac-secret/reveal is admin-only (403 for reviewer role)", async () => {
    const res = await request(app)
      .post("/api/v1/settings/hmac-secret/reveal")
      .set("Authorization", `Bearer ${reviewerToken}`);
    expect(res.status).toBe(403);
  });

  it("POST /hmac-secret/reveal emits a `hmac_secret.revealed` audit entry", async () => {
    // Trigger the reveal — emitted audit is fire-and-forget, give it a tick.
    const res = await request(app)
      .post("/api/v1/settings/hmac-secret/reveal")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));

    const events = await testDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "hmac_secret.revealed"));
    expect(events.length).toBeGreaterThanOrEqual(1);
    const latest = events[events.length - 1];
    expect(latest.actor).toBe("reviewer:hmac-admin@test.local");
    expect(latest.resource_type).toBe("project");
    expect(latest.resource_id).toBe(projectId);
    const details = latest.details as { prefix: string; ip: string | null; user_agent: string | null };
    expect(details.prefix).toBe(originalSecret.slice(0, 8));
  });

  it("POST /hmac-secret/rotate emits a `hmac_secret.rotated` audit entry carrying prev/new prefixes", async () => {
    const res = await request(app)
      .post("/api/v1/settings/hmac-secret/rotate")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.hmac_secret).toBe("string");
    expect(res.body.hmac_secret.length).toBeGreaterThanOrEqual(32);
    await new Promise((r) => setTimeout(r, 30));

    const events = await testDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "hmac_secret.rotated"));
    expect(events.length).toBeGreaterThanOrEqual(1);
    const latest = events[events.length - 1];
    expect(latest.actor).toBe("reviewer:hmac-admin@test.local");
    const details = latest.details as { prev_prefix: string; new_prefix: string };
    expect(details.prev_prefix).toBe(originalSecret.slice(0, 8));
    expect(details.new_prefix).toBe(res.body.hmac_secret.slice(0, 8));
  });
});

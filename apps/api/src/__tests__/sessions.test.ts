import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { createApp } from "../app";
import { createSessionService } from "../services/sessions";

describe("Session management", () => {
  let db: any;
  let client: any;
  let app: Express;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;
    await seedTestProject(db);
    app = createApp({ db });
  });

  afterAll(async () => {
    await client?.close();
  });

  describe("Login creates session", () => {
    it("login creates a session row in the database", async () => {
      const seed = await seedReviewer(db, app, { email: "sess-create@test.com", role: "admin" });
      const { sessions } = await import("@gatewerk/db/src/schema/index");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select().from(sessions).where(eq(sessions.reviewer_id, seed.reviewer.id));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].jti).toBeTruthy();
      expect(rows[0].revoked_at).toBeNull();
    });

    it("authenticated request succeeds with valid session", async () => {
      const seed = await seedReviewer(db, app, { email: "sess-auth@test.com", role: "admin" });
      const res = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${seed.sessionToken}`);
      expect(res.status).toBe(200);
      expect(res.body.email).toBe("sess-auth@test.com");
    });
  });

  describe("GET /api/v1/auth/sessions", () => {
    it("lists active sessions for current reviewer", async () => {
      const seed = await seedReviewer(db, app, { email: "sess-list@test.com", role: "admin" });
      const res = await request(app)
        .get("/api/v1/auth/sessions")
        .set("Authorization", `Bearer ${seed.sessionToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toBeInstanceOf(Array);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
      const current = res.body.items.find((s: any) => s.is_current);
      expect(current).toBeTruthy();
    });

    it("returns 401 without auth", async () => {
      const res = await request(app).get("/api/v1/auth/sessions");
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /api/v1/auth/sessions/:id", () => {
    it("revokes a non-current session", async () => {
      const seed = await seedReviewer(db, app, { email: "sess-revoke@test.com", role: "admin" });
      const firstToken = seed.sessionToken;

      // Create a second session via login
      const loginRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "sess-revoke@test.com", password: "password123" });
      const secondToken = loginRes.body.token;

      // List sessions from second token
      const listRes = await request(app)
        .get("/api/v1/auth/sessions")
        .set("Authorization", `Bearer ${secondToken}`);
      const nonCurrent = listRes.body.items.find((s: any) => !s.is_current);
      expect(nonCurrent).toBeTruthy();

      // Revoke the non-current session
      const revokeRes = await request(app)
        .delete(`/api/v1/auth/sessions/${nonCurrent.id}`)
        .set("Authorization", `Bearer ${secondToken}`);
      expect(revokeRes.status).toBe(200);

      // Verify the revoked session's token no longer works
      const meRes = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${firstToken}`);
      expect(meRes.status).toBe(401);
    });

    it("returns 404 for unknown session id", async () => {
      const seed = await seedReviewer(db, app, { email: "sess-404@test.com", role: "admin" });
      const res = await request(app)
        .delete("/api/v1/auth/sessions/nonexistent")
        .set("Authorization", `Bearer ${seed.sessionToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/v1/auth/sessions/revoke-all", () => {
    it("revokes all sessions except current", async () => {
      const seed = await seedReviewer(db, app, { email: "sess-revokeall@test.com", role: "admin" });

      // Create more sessions
      await request(app).post("/api/v1/auth/login").send({ email: "sess-revokeall@test.com", password: "password123" });
      await request(app).post("/api/v1/auth/login").send({ email: "sess-revokeall@test.com", password: "password123" });

      // Login one more time for the "current" session
      const currentLogin = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "sess-revokeall@test.com", password: "password123" });
      const currentToken = currentLogin.body.token;

      // Revoke all others
      const revokeRes = await request(app)
        .post("/api/v1/auth/sessions/revoke-all")
        .set("Authorization", `Bearer ${currentToken}`);
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.revoked_count).toBeGreaterThanOrEqual(3);

      // Current session still works
      const meRes = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${currentToken}`);
      expect(meRes.status).toBe(200);

      // Old session token should fail
      const oldMeRes = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${seed.sessionToken}`);
      expect(oldMeRes.status).toBe(401);
    });
  });

  describe("POST /api/v1/auth/logout", () => {
    it("revokes current session", async () => {
      const loginRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "sess-revokeall@test.com", password: "password123" });
      const token = loginRes.body.token;

      const logoutRes = await request(app)
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${token}`);
      expect(logoutRes.status).toBe(200);

      // Token no longer works
      const meRes = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${token}`);
      expect(meRes.status).toBe(401);
    });
  });

  describe("Password change revokes sessions", () => {
    it("other sessions are invalidated after password change", async () => {
      const seed = await seedReviewer(db, app, { email: "sess-pwchange@test.com", role: "admin" });
      const oldToken = seed.sessionToken;

      // Login again to get a second session
      const secondLogin = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "sess-pwchange@test.com", password: "password123" });
      const secondToken = secondLogin.body.token;

      // Change password from second session
      const changeRes = await request(app)
        .post("/api/v1/auth/change-password")
        .set("Authorization", `Bearer ${secondToken}`)
        .send({ current_password: "password123", new_password: "newpassword456" });
      expect(changeRes.status).toBe(200);

      // Old token should be invalidated
      const meRes = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${oldToken}`);
      expect(meRes.status).toBe(401);

      // New token from change-password response should work
      const newToken = changeRes.body.token;
      const newMeRes = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${newToken}`);
      expect(newMeRes.status).toBe(200);
    });
  });
});

describe("SessionService.cleanup — retention windows", () => {
  let db: any;
  let client: any;
  let service: ReturnType<typeof createSessionService>;

  // Minimal reviewer row required by the sessions FK.
  const reviewerId = "rev_cleanup_test";

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;
    service = createSessionService(db);

    const { reviewers } = await import("@gatewerk/db/src/schema/index");
    const bcrypt = await import("bcryptjs");
    await db.insert(reviewers).values({
      id: reviewerId,
      email: "cleanup@test.com",
      name: "Cleanup Tester",
      password_hash: await bcrypt.hash("pw", 10),
      role: "reviewer",
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  async function insertSession(overrides: {
    revokedHoursAgo?: number;
    expiredDaysAgo?: number;
    expiresInDays?: number;
  }) {
    const { sessions } = await import("@gatewerk/db/src/schema/index");
    const { generateId } = await import("@gatewerk/shared");
    const crypto = await import("crypto");

    const now = Date.now();
    const revokedAt = overrides.revokedHoursAgo != null
      ? new Date(now - overrides.revokedHoursAgo * 60 * 60 * 1000)
      : null;
    const expiresAt = overrides.expiredDaysAgo != null
      ? new Date(now - overrides.expiredDaysAgo * 24 * 60 * 60 * 1000)
      : new Date(now + (overrides.expiresInDays ?? 7) * 24 * 60 * 60 * 1000);

    const [row] = await db.insert(sessions).values({
      id: generateId("session"),
      reviewer_id: reviewerId,
      jti: crypto.randomBytes(16).toString("hex"),
      expires_at: expiresAt,
      revoked_at: revokedAt,
    }).returning();

    return row;
  }

  it("deletes a revoked session older than 48h", async () => {
    const { sessions } = await import("@gatewerk/db/src/schema/index");
    const { eq } = await import("drizzle-orm");

    const row = await insertSession({ revokedHoursAgo: 49 });
    const deleted = await service.cleanup();
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await db.select().from(sessions).where(eq(sessions.id, row.id));
    expect(remaining.length).toBe(0);
  });

  it("keeps a revoked session younger than 48h", async () => {
    const { sessions } = await import("@gatewerk/db/src/schema/index");
    const { eq } = await import("drizzle-orm");

    const row = await insertSession({ revokedHoursAgo: 24 });
    await service.cleanup();

    const remaining = await db.select().from(sessions).where(eq(sessions.id, row.id));
    expect(remaining.length).toBe(1);
  });

  it("keeps a never-revoked session expired only 5 days ago", async () => {
    const { sessions } = await import("@gatewerk/db/src/schema/index");
    const { eq } = await import("drizzle-orm");

    const row = await insertSession({ expiredDaysAgo: 5 });
    await service.cleanup();

    const remaining = await db.select().from(sessions).where(eq(sessions.id, row.id));
    expect(remaining.length).toBe(1);
  });

  it("deletes a never-revoked session expired more than 30 days ago", async () => {
    const { sessions } = await import("@gatewerk/db/src/schema/index");
    const { eq } = await import("drizzle-orm");

    const row = await insertSession({ expiredDaysAgo: 31 });
    const deleted = await service.cleanup();
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await db.select().from(sessions).where(eq(sessions.id, row.id));
    expect(remaining.length).toBe(0);
  });

  it("listForReviewer orders sessions newest last_active_at first", async () => {
    const { sessions } = await import("@gatewerk/db/src/schema/index");
    const { generateId } = await import("@gatewerk/shared");
    const crypto = await import("crypto");

    const orderReviewerId = "rev_order_test";
    const { reviewers } = await import("@gatewerk/db/src/schema/index");
    const bcrypt = await import("bcryptjs");
    await db.insert(reviewers).values({
      id: orderReviewerId,
      email: "order@test.com",
      name: "Order Tester",
      password_hash: await bcrypt.hash("pw", 10),
      role: "reviewer",
    });

    const now = Date.now();
    async function insertActiveSession(minutesAgo: number) {
      const [row] = await db
        .insert(sessions)
        .values({
          id: generateId("session"),
          reviewer_id: orderReviewerId,
          jti: crypto.randomBytes(16).toString("hex"),
          expires_at: new Date(now + 7 * 24 * 60 * 60 * 1000),
          last_active_at: new Date(now - minutesAgo * 60 * 1000),
        })
        .returning();
      return row;
    }

    const oldest = await insertActiveSession(120);
    const newest = await insertActiveSession(1);
    const middle = await insertActiveSession(30);

    const list = await service.listForReviewer(orderReviewerId);
    expect(list.map((s) => s.id)).toEqual([newest.id, middle.id, oldest.id]);
  });
});

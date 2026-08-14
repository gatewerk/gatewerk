import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../../../app";
import { createTestDb, seedTestProject, seedReviewer } from "../../../__tests__/helpers/test-db";
import { reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import * as argon2 from "argon2";

function makeAuditService(): any {
  return { log: vi.fn(async () => {}) };
}

describe("GET /api/v1/admin/password-hash-stats", () => {
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

    // Seed admin + reviewer via helper (these get bcrypt hashes from seedReviewer)
    const admin = await seedReviewer(db, app, {
      email: "admin-hashstats@test.local",
      password: "password123",
      role: "admin",
    });
    adminToken = admin.sessionToken;

    const reviewer = await seedReviewer(db, app, {
      email: "reviewer-hashstats@test.local",
      password: "password123",
      role: "reviewer",
    });
    reviewerToken = reviewer.sessionToken;

    // Seed an additional user with a raw bcrypt hash (simulates legacy non-login-upgraded user)
    const bcryptHash = await bcrypt.hash("somepass", 10);
    await db.insert(reviewers).values({
      id: generateId("user"),
      email: "legacy-bcrypt@test.local",
      name: "Legacy Bcrypt User",
      password_hash: bcryptHash,
      role: "reviewer",
      is_active: true,
    });

    // Seed a user with argon2id hash
    const argon2Hash = await argon2.hash("somepass", {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    await db.insert(reviewers).values({
      id: generateId("user"),
      email: "argon2id@test.local",
      name: "Argon2id User",
      password_hash: argon2Hash,
      role: "reviewer",
      is_active: true,
    });
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/v1/admin/password-hash-stats");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin role", async () => {
    const res = await request(app)
      .get("/api/v1/admin/password-hash-stats")
      .set("Authorization", `Bearer ${reviewerToken}`);
    expect(res.status).toBe(403);
  });

  it("returns aggregate hash format distribution for admin", async () => {
    const res = await request(app)
      .get("/api/v1/admin/password-hash-stats")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: expect.any(Number),
      formats: expect.any(Object),
      argon2id_pct: expect.any(Number),
    });

    // We seeded at least 1 explicit argon2id user and at least 1 explicit bcrypt user.
    // Note: seedReviewer logs in (triggering rehash-on-login), so admin + reviewer
    // seeded via seedReviewer may already be argon2id by the time the stats are fetched.
    expect(res.body.formats.argon2id).toBeGreaterThanOrEqual(1);
    expect(res.body.formats.bcrypt).toBeGreaterThanOrEqual(1);
    expect(res.body.total).toBe(
      (res.body.formats.argon2id ?? 0) +
      (res.body.formats.bcrypt ?? 0) +
      (res.body.formats.unknown ?? 0),
    );
    expect(res.body.argon2id_pct).toBeGreaterThanOrEqual(0);
    expect(res.body.argon2id_pct).toBeLessThanOrEqual(100);
  });
});

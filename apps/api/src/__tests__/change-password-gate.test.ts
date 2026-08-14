import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

// Locks the launch-readiness Phase 1 §7 G1 contract: /auth/change-password
// must verify current_password unless the reviewer is in the forced
// first-login flow (must_change_password=true). A stolen-JWT holder without
// the old password must not be able to rewrite credentials.
describe("POST /api/v1/auth/change-password — current_password gate (§7 G1)", () => {
  let app: any;
  let db: any;
  const forcedEmail = "forced-change@test.local";
  const voluntaryEmail = "voluntary-change@test.local";
  const originalPassword = "original-password-123";

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    await seedTestProject(db);

    const hash = await bcrypt.hash(originalPassword, 10);

    await db.insert(reviewers).values({
      id: generateId("user"),
      email: forcedEmail,
      name: "Forced",
      password_hash: hash,
      role: "reviewer",
      must_change_password: true,
    });

    await db.insert(reviewers).values({
      id: generateId("user"),
      email: voluntaryEmail,
      name: "Voluntary",
      password_hash: hash,
      role: "reviewer",
      must_change_password: false,
    });

    app = createApp({ db });
  });

  async function login(email: string, password: string): Promise<string> {
    const res = await request(app).post("/api/v1/auth/login").send({ email, password });
    expect(res.status).toBe(200);
    return res.body.token;
  }

  it("allows forced first-login change WITHOUT current_password", async () => {
    const token = await login(forcedEmail, originalPassword);
    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ new_password: "brand-new-password-456" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();

    const [row] = await db
      .select()
      .from(reviewers)
      .where(eq(reviewers.email, forcedEmail))
      .limit(1);
    expect(row.must_change_password).toBe(false);
  });

  it("rejects voluntary change without current_password (400 missing_current_password)", async () => {
    const token = await login(voluntaryEmail, originalPassword);
    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ new_password: "attacker-chosen-password-789" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_current_password");

    // Password must NOT have changed.
    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: voluntaryEmail, password: originalPassword });
    expect(loginRes.status).toBe(200);
  });

  it("rejects voluntary change with wrong current_password (400 incorrect_password)", async () => {
    const token = await login(voluntaryEmail, originalPassword);
    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({
        current_password: "wrong-old-password",
        new_password: "attacker-chosen-password-789",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("incorrect_password");

    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: voluntaryEmail, password: originalPassword });
    expect(loginRes.status).toBe(200);
  });

  it("accepts voluntary change with correct current_password and rotates token_version", async () => {
    const token = await login(voluntaryEmail, originalPassword);

    const [before] = await db
      .select({ tv: reviewers.token_version })
      .from(reviewers)
      .where(eq(reviewers.email, voluntaryEmail))
      .limit(1);

    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({
        current_password: originalPassword,
        new_password: "user-chosen-password-abc",
      });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();

    const [after] = await db
      .select({ tv: reviewers.token_version })
      .from(reviewers)
      .where(eq(reviewers.email, voluntaryEmail))
      .limit(1);
    expect(after.tv).toBe((before.tv ?? 0) + 1);

    // New password works.
    const newLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: voluntaryEmail, password: "user-chosen-password-abc" });
    expect(newLogin.status).toBe(200);
  });
});

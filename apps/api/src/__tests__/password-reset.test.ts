import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { reviewers } from "@gatewerk/db/src/schema/index";
import type { Express } from "express";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { createApp } from "../app";

describe("Password reset", () => {
  let db: any;
  let client: any;
  let app: Express;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;
    await seedTestProject(db);
    app = createApp({ db });
    await seedReviewer(db, app, { email: "reset@test.com", role: "admin" });
  });

  afterAll(async () => {
    await client?.close();
  });

  it("POST /forgot-password returns 200 for existing email", async () => {
    const res = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: "reset@test.com" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /forgot-password returns 200 for non-existent email (no enumeration)", async () => {
    const res = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: "nonexistent@test.com" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /reset-password with invalid token returns 400", async () => {
    const res = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: "invalid-token", new_password: "newSecurePass123" });
    expect(res.status).toBe(400);
  });

  it("POST /reset-password with valid token resets password", async () => {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const [reviewer] = await db
      .select()
      .from(reviewers)
      .where(eq(reviewers.email, "reset@test.com"))
      .limit(1);

    await db
      .update(reviewers)
      .set({
        password_reset_token_hash: tokenHash,
        password_reset_expires_at: new Date(Date.now() + 3600000),
      })
      .where(eq(reviewers.id, reviewer.id));

    const res = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: rawToken, new_password: "newSecurePass123" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify can login with new password
    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "reset@test.com", password: "newSecurePass123" });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeDefined();
  });

  it("POST /reset-password with expired token returns 400", async () => {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const [reviewer] = await db
      .select()
      .from(reviewers)
      .where(eq(reviewers.email, "reset@test.com"))
      .limit(1);

    await db
      .update(reviewers)
      .set({
        password_reset_token_hash: tokenHash,
        password_reset_expires_at: new Date(Date.now() - 1000),
      })
      .where(eq(reviewers.id, reviewer.id));

    const res = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: rawToken, new_password: "anotherPass123" });
    expect(res.status).toBe(400);
  });
});

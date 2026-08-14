import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { createApp } from "../app";

describe("Account lockout", () => {
  let db: any;
  let client: any;
  let app: Express;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;
    await seedTestProject(db);
    app = createApp({ db });
    await seedReviewer(db, app, { email: "lockout@test.com", role: "admin" });
  });

  afterAll(async () => {
    await client?.close();
  });

  it("allows login with correct credentials", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "lockout@test.com", password: "password123" });
    expect(res.status).toBe(200);
  });

  it("locks account after 5 failed attempts", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "lockout@test.com", password: "wrongpassword" });
    }

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "lockout@test.com", password: "password123" });
    expect(res.status).toBe(429);
    expect(res.body.error.message).toContain("Too many failed");
    expect(res.body.error.code).toBe("account_locked");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(parseInt(res.headers["retry-after"], 10)).toBeGreaterThan(0);
  });

  it("resets lockout after successful login (when counter is below threshold)", async () => {
    await seedReviewer(db, app, { email: "lockout-reset@test.com", role: "reviewer" });

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "lockout-reset@test.com", password: "wrong" });
    }

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "lockout-reset@test.com", password: "password123" });
    expect(res.status).toBe(200);

    for (let i = 0; i < 4; i++) {
      const failRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "lockout-reset@test.com", password: "wrong" });
      expect(failRes.status).toBe(401);
    }
  });

  it("does not leak email existence via lockout response", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "nonexistent@test.com", password: "wrong" });
      expect(res.status).toBe(401);
    }
  });

  it("returns 429 with Retry-After header", async () => {
    await seedReviewer(db, app, { email: "lockout-header@test.com", role: "reviewer" });

    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "lockout-header@test.com", password: "wrong" });
    }

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "lockout-header@test.com", password: "wrong" });
    expect(res.status).toBe(429);
    expect(parseInt(res.headers["retry-after"])).toBeGreaterThan(0);
  });
});

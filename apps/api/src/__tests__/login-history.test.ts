import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { createApp } from "../app";

describe("Login history", () => {
  let db: any;
  let client: any;
  let app: Express;
  let sessionToken: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;
    await seedTestProject(db);
    app = createApp({ db });
    const seed = await seedReviewer(db, app, { email: "history@test.com", role: "admin" });
    sessionToken = seed.sessionToken;

    await request(app).post("/api/v1/auth/login").send({ email: "history@test.com", password: "password123" });
    await request(app).post("/api/v1/auth/login").send({ email: "history@test.com", password: "wrong" });
  });

  afterAll(async () => {
    await client?.close();
  });

  it("returns login history for current user", async () => {
    const res = await request(app)
      .get("/api/v1/auth/login-history")
      .set("Authorization", `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toBeInstanceOf(Array);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  });

  it("respects limit and offset", async () => {
    const res = await request(app)
      .get("/api/v1/auth/login-history?limit=1&offset=0")
      .set("Authorization", `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(1);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/v1/auth/login-history");
    expect(res.status).toBe(401);
  });
});

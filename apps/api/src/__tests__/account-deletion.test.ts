import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { reviewers } from "@gatewerk/db/src/schema/index";
import type { Express } from "express";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { createApp } from "../app";

describe("Account deletion", () => {
  let db: any;
  let client: any;
  let app: Express;
  let sessionToken: string;
  let reviewerId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;
    await seedTestProject(db);
    app = createApp({ db });
    const seed = await seedReviewer(db, app, { email: "delete-me@test.com", role: "reviewer" });
    sessionToken = seed.sessionToken;
    reviewerId = seed.reviewer.id;
  });

  afterAll(async () => {
    await client?.close();
  });

  it("returns 400 when current_password is missing", async () => {
    const res = await request(app)
      .delete("/api/v1/auth/account")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when current_password is wrong", async () => {
    const res = await request(app)
      .delete("/api/v1/auth/account")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ current_password: "wrongpassword" });
    expect(res.status).toBe(400);
  });

  it("deletes account with correct password and anonymizes data", async () => {
    const res = await request(app)
      .delete("/api/v1/auth/account")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ current_password: "password123" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify anonymization
    const [reviewer] = await db
      .select()
      .from(reviewers)
      .where(eq(reviewers.id, reviewerId));
    expect(reviewer.email).toBe(`deleted-${reviewerId}@deleted.local`);
    expect(reviewer.name).toBe("Deleted User");
    expect(reviewer.is_active).toBe(false);

    // Verify session is revoked (token no longer works)
    const meRes = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${sessionToken}`);
    expect(meRes.status).toBe(401);
  });

  it("returns 401 without auth token", async () => {
    const res = await request(app)
      .delete("/api/v1/auth/account")
      .send({ current_password: "password123" });
    expect(res.status).toBe(401);
  });
});

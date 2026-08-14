import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { createApp } from "../app";

describe("Data export", () => {
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
    const seed = await seedReviewer(db, app, { email: "export@test.com", role: "admin" });
    sessionToken = seed.sessionToken;
  });

  afterAll(async () => {
    await client?.close();
  });

  it("returns JSON with user profile data", async () => {
    const res = await request(app)
      .get("/api/v1/auth/data-export")
      .set("Authorization", `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.profile).toBeDefined();
    expect(res.body.profile.email).toBe("export@test.com");
    expect(res.body.exported_at).toBeDefined();
    expect(res.body.auth_events_last_90_days).toBeDefined();
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/v1/auth/data-export");
    expect(res.status).toBe(401);
  });

  it("sets Content-Disposition attachment header", async () => {
    const res = await request(app)
      .get("/api/v1/auth/data-export")
      .set("Authorization", `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain("gatewerk-data-export.json");
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("Role-based access control", () => {
  let app: any;
  let client: any;
  let adminToken: string;
  let reviewerToken: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    const db = testDb.db;
    await seedTestProject(db);

    const hash = await bcrypt.hash("pass123", 10);

    await db.insert(reviewers).values({
      id: generateId("user"),
      email: "admin@test.local",
      name: "Admin",
      password_hash: hash,
      role: "admin",
    });

    await db.insert(reviewers).values({
      id: generateId("user"),
      email: "reviewer@test.local",
      name: "Reviewer",
      password_hash: hash,
      role: "reviewer",
    });

    app = createApp({ db });

    const adminLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "pass123" });
    adminToken = adminLogin.body.token;

    const reviewerLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "reviewer@test.local", password: "pass123" });
    reviewerToken = reviewerLogin.body.token;
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("allows admin to create team invites", async () => {
    const res = await request(app)
      .post("/api/v1/settings/team/invite")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "new@test.local", role: "reviewer" });
    expect(res.status).toBe(201);
  });

  it("blocks non-admin from creating team invites", async () => {
    const res = await request(app)
      .post("/api/v1/settings/team/invite")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ email: "hack@test.local", role: "admin" });
    expect(res.status).toBe(403);
  });

  it("allows reviewer to read team list", async () => {
    const res = await request(app)
      .get("/api/v1/settings/team")
      .set("Authorization", `Bearer ${reviewerToken}`);
    expect(res.status).toBe(200);
  });

  // Regressions for the session-auth scope bypass:
  // before the fix, session auth skipped scope checks entirely, letting any
  // logged-in reviewer hit write routes gated by requireScope(...).
  it("blocks reviewer session from creating templates", async () => {
    const res = await request(app)
      .post("/api/v1/templates")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({
        slug: "hack",
        name: "hack",
        fields: [{ name: "x", type: "text", label: "X" }],
        actions: ["approve", "reject"],
      });
    expect(res.status).toBe(403);
  });

  it("blocks reviewer session from creating reviews", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ template: "anything", payload: {} });
    expect(res.status).toBe(403);
  });

  it("allows admin session to create templates", async () => {
    const res = await request(app)
      .post("/api/v1/templates")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        slug: "allowed-tpl",
        name: "Allowed",
        fields: [{ name: "x", type: "text", label: "X" }],
        actions: ["approve", "reject"],
      });
    expect([200, 201]).toContain(res.status);
  });

  // Regression for the settings admin-gate gaps closed in launch-readiness
  // Phase 1 (HMAC-GET sibling class). Before the fix, any session-authenticated
  // reviewer could mutate project-wide outgoing-webhook config and redirect
  // event streams to attacker-controlled URLs.
  it("blocks non-admin from creating outgoing webhooks", async () => {
    const res = await request(app)
      .post("/api/v1/settings/webhooks")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({
        name: "Attack",
        webhook_url: "https://evil.example.com/steal",
        events: ["review.created"],
      });
    expect(res.status).toBe(403);
  });

  it("blocks non-admin from updating outgoing webhooks", async () => {
    const res = await request(app)
      .put("/api/v1/settings/webhooks/ch_any")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ webhook_url: "https://evil.example.com/steal" });
    expect(res.status).toBe(403);
  });

  it("blocks non-admin from deleting outgoing webhooks", async () => {
    const res = await request(app)
      .delete("/api/v1/settings/webhooks/ch_any")
      .set("Authorization", `Bearer ${reviewerToken}`);
    expect(res.status).toBe(403);
  });

  it("blocks non-admin from updating project config", async () => {
    const res = await request(app)
      .put("/api/v1/settings/project")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ webhook_url: "https://evil.example.com/steal" });
    expect(res.status).toBe(403);
  });
});

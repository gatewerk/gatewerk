import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("Settings API", () => {
  let app: any;
  let client: any;
  let token: string;
  let projectId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    const db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;

    // Seed an admin reviewer
    const hash = await bcrypt.hash("admin123", 10);
    await db.insert(reviewers).values({
      id: generateId("user"),
      email: "admin@test.local",
      name: "Test Admin",
      password_hash: hash,
      role: "admin",
    });

    app = createApp({ db });

    // Login to get JWT
    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "admin123" });
    token = loginRes.body.token;
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  // ─── Project Settings ───

  describe("GET /api/v1/settings/project", () => {
    it("returns project info with API key prefixes", async () => {
      const res = await request(app)
        .get("/api/v1/settings/project")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(projectId);
      expect(res.body.name).toBe("Test Project");
      expect(res.body.api_keys).toBeDefined();
      expect(res.body.api_keys.length).toBeGreaterThan(0);
      expect(res.body.api_keys[0].key_prefix).toBe("gwk_test1");
    });

    it("rejects unauthenticated requests", async () => {
      const res = await request(app).get("/api/v1/settings/project");
      expect(res.status).toBe(401);
    });
  });

  describe("PUT /api/v1/settings/project", () => {
    it("updates project name and webhook_url", async () => {
      const res = await request(app)
        .put("/api/v1/settings/project")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Updated Project", webhook_url: "https://example.com/hook" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Updated Project");
      expect(res.body.webhook_url).toBe("https://example.com/hook");
    });
  });

  // ─── Notification Channels ───

  let channelId: string;

  describe("POST /api/v1/settings/webhooks", () => {
    it("creates a notification channel", async () => {
      const res = await request(app)
        .post("/api/v1/settings/webhooks")
        .set("Authorization", `Bearer ${token}`)
        .send({
          name: "Slack",
          webhook_url: "https://hooks.slack.com/test",
          events: ["review.created", "review.urgent"],
        });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Slack");
      expect(res.body.events).toEqual(["review.created", "review.urgent"]);
      expect(res.body.is_active).toBe(true);
      channelId = res.body.id;
    });

    it("rejects missing required fields with 422", async () => {
      const res = await request(app)
        .post("/api/v1/settings/webhooks")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Missing" });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("validation_failed");
    });
  });

  describe("GET /api/v1/settings/webhooks", () => {
    it("lists channels for the project", async () => {
      const res = await request(app)
        .get("/api/v1/settings/webhooks")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBe(1);
      expect(res.body.items[0].name).toBe("Slack");
    });
  });

  describe("PUT /api/v1/settings/webhooks/:id", () => {
    it("updates a channel", async () => {
      const res = await request(app)
        .put(`/api/v1/settings/webhooks/${channelId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ is_active: false });

      expect(res.status).toBe(200);
      expect(res.body.is_active).toBe(false);
    });
  });

  describe("DELETE /api/v1/settings/webhooks/:id", () => {
    it("deletes a channel", async () => {
      const res = await request(app)
        .delete(`/api/v1/settings/webhooks/${channelId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(204);

      // Verify deletion
      const listRes = await request(app)
        .get("/api/v1/settings/webhooks")
        .set("Authorization", `Bearer ${token}`);
      expect(listRes.body.items.length).toBe(0);
    });
  });

  // ─── Team Members ───

  let memberId: string;

  describe("GET /api/v1/settings/team", () => {
    it("lists team members", async () => {
      const res = await request(app)
        .get("/api/v1/settings/team")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBe(1); // the admin seeded in beforeAll
      expect(res.body.items[0].email).toBe("admin@test.local");
    });
  });

  describe("GET /api/v1/auth/invite/:token (public validate)", () => {
    it("returns email, role, inviter_name and team_name for a valid token", async () => {
      const inviteRes = await request(app)
        .post("/api/v1/settings/team/invite")
        .set("Authorization", `Bearer ${token}`)
        .send({ email: "peek@test.local", role: "reviewer" });
      expect(inviteRes.status).toBe(201);
      const inviteToken = inviteRes.body.invite_url.split("/").pop();

      const res = await request(app).get(`/api/v1/auth/invite/${inviteToken}`);

      expect(res.status).toBe(200);
      expect(res.body.email).toBe("peek@test.local");
      expect(res.body.role).toBe("reviewer");
      // The accept screen greets the invitee with who invited them and to
      // what — sourced from invited_by and the instance project.
      expect(res.body.inviter_name).toBe("Test Admin");
      expect(res.body.team_name).toBe("Updated Project"); // renamed by the PUT test above
    });

    it("still 404s an invalid token without leaking fields", async () => {
      const res = await request(app).get("/api/v1/auth/invite/not-a-real-token");
      expect(res.status).toBe(404);
      expect(res.body.inviter_name).toBeUndefined();
      expect(res.body.team_name).toBeUndefined();
    });
  });

  describe("POST /api/v1/settings/team/invite (invite flow)", () => {
    it("creates a new reviewer via invite flow", async () => {
      // Step 1: Admin generates invite token
      const inviteRes = await request(app)
        .post("/api/v1/settings/team/invite")
        .set("Authorization", `Bearer ${token}`)
        .send({ email: "new@test.local", role: "reviewer" });

      expect(inviteRes.status).toBe(201);
      expect(inviteRes.body.email).toBe("new@test.local");
      expect(inviteRes.body.invite_url).toBeDefined();

      // Raw token is no longer returned as a separate field — extract it
      // from invite_url (the URL is the only consumer-facing payload).
      const inviteToken = inviteRes.body.invite_url.split("/").pop();

      // Step 2: Recipient accepts the invite
      const acceptRes = await request(app)
        .post(`/api/v1/auth/invite/${inviteToken}`)
        .send({ name: "New Reviewer", password: "securepassword12" });

      expect(acceptRes.status).toBe(201);
      expect(acceptRes.body.reviewer.name).toBe("New Reviewer");
      expect(acceptRes.body.reviewer.role).toBe("reviewer");
      memberId = acceptRes.body.reviewer.id;
    });

    it("rejects duplicate email", async () => {
      const res = await request(app)
        .post("/api/v1/settings/team/invite")
        .set("Authorization", `Bearer ${token}`)
        .send({ email: "new@test.local", role: "reviewer" });

      expect(res.status).toBe(409);
    });

    it("rejects missing fields with 422", async () => {
      const res = await request(app)
        .post("/api/v1/settings/team/invite")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("validation_failed");
    });
  });

  describe("PUT /api/v1/settings/team/:id", () => {
    it("updates reviewer role", async () => {
      const res = await request(app)
        .put(`/api/v1/settings/team/${memberId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ role: "admin" });

      expect(res.status).toBe(200);
      expect(res.body.role).toBe("admin");
    });
  });

  describe("DELETE /api/v1/settings/team/:id", () => {
    it("deactivates a reviewer (soft delete)", async () => {
      const res = await request(app)
        .delete(`/api/v1/settings/team/${memberId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(204);

      // Verify deactivated, not deleted
      const listRes = await request(app)
        .get("/api/v1/settings/team")
        .set("Authorization", `Bearer ${token}`);
      const deactivated = listRes.body.items.find((m: any) => m.id === memberId);
      expect(deactivated).toBeDefined();
      expect(deactivated.is_active).toBe(false);
    });
  });
});

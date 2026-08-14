import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviewers, templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("Reviewer Authentication", () => {
  let app: any;
  let apiKey: string;
  let client: any;
  let reviewerEmail = "reviewer@example.com";
  let reviewerPassword = "secure-password-123";

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    const db = testDb.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;

    // Seed a reviewer with a bcrypt-hashed password
    const passwordHash = await bcrypt.hash(reviewerPassword, 10);
    await db.insert(reviewers).values({
      id: generateId("user"),
      email: reviewerEmail,
      name: "Test Reviewer",
      password_hash: passwordHash,
      role: "reviewer",
    });

    // Create a template for the decide test
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "auth-test",
      project_id: seed.project.id,
      name: "Auth Test Template",
      fields: [{ name: "content", type: "text", label: "Content", editable: true }],
      actions: ["approve", "reject"],
    });

    app = createApp({ db });
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  describe("POST /api/v1/auth/login", () => {
    it("returns JWT on valid credentials", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: reviewerEmail, password: reviewerPassword });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(typeof res.body.token).toBe("string");
      expect(res.body.reviewer).toBeDefined();
      expect(res.body.reviewer.email).toBe(reviewerEmail);
      expect(res.body.reviewer.name).toBe("Test Reviewer");
      expect(res.body.reviewer.role).toBe("reviewer");
      expect(res.body.reviewer.password_hash).toBeUndefined();
    });

    it("rejects invalid password (401)", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: reviewerEmail, password: "wrong-password" });

      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe("authentication_error");
    });

    it("rejects unknown email (401)", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "nobody@example.com", password: reviewerPassword });

      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe("authentication_error");
    });

    it("rejects missing fields (400)", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: reviewerEmail });

      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe("invalid_request");
    });
  });

  describe("GET /api/v1/auth/me", () => {
    it("returns reviewer info with valid token", async () => {
      // First login to get a token
      const loginRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: reviewerEmail, password: reviewerPassword });
      const token = loginRes.body.token;

      const res = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.email).toBe(reviewerEmail);
      expect(res.body.name).toBe("Test Reviewer");
      expect(res.body.role).toBe("reviewer");
      expect(res.body.id).toBeDefined();
    });

    it("rejects request without token (401)", async () => {
      const res = await request(app).get("/api/v1/auth/me");

      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe("authentication_error");
    });

    it("rejects invalid token (401)", async () => {
      const res = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", "Bearer invalid-jwt-token");

      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe("authentication_error");
    });

    it("returns last_login_at and created_at fields", async () => {
      const loginRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: reviewerEmail, password: reviewerPassword });
      const token = loginRes.body.token;

      const res = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.last_login_at).toBeDefined();
      expect(res.body.created_at).toBeDefined();
    });
  });

  describe("PUT /api/v1/auth/profile", () => {
    // Use a function to always get a fresh token (password changes invalidate old tokens)
    async function getFreshToken() {
      const loginRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: reviewerEmail, password: reviewerPassword });
      return loginRes.body.token;
    }

    it("updates name", async () => {
      const token = await getFreshToken();
      const res = await request(app)
        .put("/api/v1/auth/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Updated Name" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Updated Name");
      expect(res.body.email).toBe(reviewerEmail);
      expect(res.body.password_hash).toBeUndefined();
    });

    it("updates password with valid current_password", async () => {
      const token = await getFreshToken();
      const res = await request(app)
        .put("/api/v1/auth/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({
          current_password: reviewerPassword,
          new_password: "new-secure-password-456",
        });

      expect(res.status).toBe(200);
      // Password change returns a fresh token (old sessions are invalidated)
      expect(res.body.token).toBeDefined();

      // Verify new password works for login
      const loginRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: reviewerEmail, password: "new-secure-password-456" });
      expect(loginRes.status).toBe(200);

      // Reset password back for other tests using the fresh token
      const freshToken = res.body.token;
      await request(app)
        .put("/api/v1/auth/profile")
        .set("Authorization", `Bearer ${freshToken}`)
        .send({
          current_password: "new-secure-password-456",
          new_password: reviewerPassword,
        });
    });

    it("rejects password change with wrong current_password (400)", async () => {
      const token = await getFreshToken();
      const res = await request(app)
        .put("/api/v1/auth/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({
          current_password: "wrong-password",
          new_password: "something-new",
        });

      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe("invalid_request");
      expect(res.body.error.message).toContain("Current password is incorrect");
    });

    it("rejects password change without current_password (400)", async () => {
      const token = await getFreshToken();
      const res = await request(app)
        .put("/api/v1/auth/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({ new_password: "something-new" });

      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe("invalid_request");
    });

    it("rejects short new_password (400)", async () => {
      const token = await getFreshToken();
      const res = await request(app)
        .put("/api/v1/auth/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({
          current_password: reviewerPassword,
          new_password: "short",
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("at least 12 characters");
    });

    it("rejects empty name (400)", async () => {
      const token = await getFreshToken();
      const res = await request(app)
        .put("/api/v1/auth/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "   " });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("non-empty string");
    });

    it("rejects request without token (401)", async () => {
      const res = await request(app)
        .put("/api/v1/auth/profile")
        .send({ name: "Hacker" });

      expect(res.status).toBe(401);
    });
  });

  describe("Session auth on review endpoints", () => {
    it("decide endpoint accepts session auth (JWT) and sets decided_by", async () => {
      // Step 1: Create a review via API key
      const createRes = await request(app)
        .post("/api/v1/reviews")
        .set("Authorization", `Bearer ${apiKey}`)
        .send({
          template: "auth-test",
          payload: { content: "Session decide test" },
          callback_url: "https://example.com/webhook",
        });
      expect(createRes.status).toBe(201);
      const reviewId = createRes.body.id;

      // Step 2: Login as reviewer to get JWT
      const loginRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: reviewerEmail, password: reviewerPassword });
      expect(loginRes.status).toBe(200);
      const token = loginRes.body.token;

      // Step 3: Decide via JWT session (no reviewer in body)
      const decideRes = await request(app)
        .post(`/api/v1/reviews/${reviewId}/decide`)
        .set("Authorization", `Bearer ${token}`)
        .send({ decision: "approved", feedback: "Looks good from session" });

      expect(decideRes.status).toBe(200);
      expect(decideRes.body.status).toBe("decided");
      expect(decideRes.body.decision).toBe("approved");
      expect(decideRes.body.decided_by).toBe(reviewerEmail);
    });
  });
});

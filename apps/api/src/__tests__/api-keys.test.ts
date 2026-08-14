import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviewers, templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import bcrypt from "bcryptjs";

describe("API Keys API", () => {
  let app: any;
  let db: any;
  let sessionToken: string;
  let project: any;
  let template: any;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    project = seed.project;

    // Create a template for review tests
    [template] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "test-template",
      project_id: project.id,
      name: "Test Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      default_priority: "normal",
    }).returning();

    // Create a second template (for scoping tests)
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "other-template",
      project_id: project.id,
      name: "Other Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      default_priority: "normal",
    }).returning();

    // Create admin reviewer for login
    await db.insert(reviewers).values({
      id: generateId("user"),
      email: "admin@gatewerk.local",
      name: "Admin",
      password_hash: await bcrypt.hash("admin123", 10),
      role: "admin",
    });

    app = createApp({ db });

    // Login to get session token
    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@gatewerk.local", password: "admin123" });

    sessionToken = loginRes.body.token;
  });

  const sessionAuth = () => ({ Authorization: `Bearer ${sessionToken}` });

  // ─── 1. List connections ───
  describe("GET /api/v1/settings/api-keys", () => {
    it("returns existing API keys", async () => {
      const res = await request(app)
        .get("/api/v1/settings/api-keys")
        .set(sessionAuth());

      expect(res.status).toBe(200);
      expect(res.body.items).toBeDefined();
      expect(Array.isArray(res.body.items)).toBe(true);
      // The seed created one key already
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
      // key_hash should be stripped
      for (const item of res.body.items) {
        expect(item.key_hash).toBeUndefined();
      }
    });
  });

  // ─── 2. Create connection ───
  describe("POST /api/v1/settings/api-keys", () => {
    it("creates an API key and returns raw_key starting with gwk_", async () => {
      const res = await request(app)
        .post("/api/v1/settings/api-keys")
        .set(sessionAuth())
        .send({
          name: "Test Agent",
          scopes: ["reviews:create", "feedback:read"],
        });

      expect(res.status).toBe(201);
      expect(res.body.raw_key).toBeDefined();
      expect(res.body.raw_key).toMatch(/^gwk_/);
      expect(res.body.name).toBe("Test Agent");
      expect(res.body.scopes).toEqual(["reviews:create", "feedback:read"]);
      expect(res.body.object).toBe("api_key");
      // key_hash should be stripped
      expect(res.body.key_hash).toBeUndefined();
    });

    // ─── 3. Create with template scoping ───
    it("creates a connection with template_ids", async () => {
      const res = await request(app)
        .post("/api/v1/settings/api-keys")
        .set(sessionAuth())
        .send({
          name: "Scoped Agent",
          scopes: ["reviews:create"],
          template_ids: [template.id],
        });

      expect(res.status).toBe(201);
      expect(res.body.template_ids).toEqual([template.id]);
    });

    // ─── 4. Create with invalid template_id ───
    it("rejects invalid template_ids with 400", async () => {
      const res = await request(app)
        .post("/api/v1/settings/api-keys")
        .set(sessionAuth())
        .send({
          name: "Bad Template Agent",
          scopes: ["reviews:create"],
          template_ids: ["gw_tpl_nonexistent"],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_template_id");
    });

    // ─── 5. Create with invalid scope ───
    it("rejects invalid scopes with 422", async () => {
      const res = await request(app)
        .post("/api/v1/settings/api-keys")
        .set(sessionAuth())
        .send({
          name: "Bad Scope Agent",
          scopes: ["invalid:scope"],
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("validation_failed");
    });
  });

  // ─── 6. Update connection ───
  describe("PUT /api/v1/settings/api-keys/:id", () => {
    it("updates a connection name", async () => {
      // Create one first
      const createRes = await request(app)
        .post("/api/v1/settings/api-keys")
        .set(sessionAuth())
        .send({ name: "To Update", scopes: ["reviews:create"] });

      const id = createRes.body.id;

      const res = await request(app)
        .put(`/api/v1/settings/api-keys/${id}`)
        .set(sessionAuth())
        .send({ name: "Updated" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Updated");
    });
  });

  // ─── 7. Rotate key ───
  describe("POST /api/v1/settings/api-keys/:id/rotate", () => {
    it("returns a new raw_key and old key no longer works", async () => {
      // Create a connection with full access for testing
      const createRes = await request(app)
        .post("/api/v1/settings/api-keys")
        .set(sessionAuth())
        .send({
          name: "Rotate Test",
          scopes: ["reviews:create", "reviews:read"],
        });

      const id = createRes.body.id;
      const oldKey = createRes.body.raw_key;

      // Verify old key works
      const check1 = await request(app)
        .get("/api/v1/reviews")
        .set({ Authorization: `Bearer ${oldKey}` });
      expect(check1.status).toBe(200);

      // Rotate
      const rotateRes = await request(app)
        .post(`/api/v1/settings/api-keys/${id}/rotate`)
        .set(sessionAuth());

      expect(rotateRes.status).toBe(200);
      expect(rotateRes.body.raw_key).toBeDefined();
      expect(rotateRes.body.raw_key).toMatch(/^gwk_/);
      expect(rotateRes.body.raw_key).not.toBe(oldKey);

      // Verify new key works
      const check2 = await request(app)
        .get("/api/v1/reviews")
        .set({ Authorization: `Bearer ${rotateRes.body.raw_key}` });
      expect(check2.status).toBe(200);

      // Verify old key no longer works
      const check3 = await request(app)
        .get("/api/v1/reviews")
        .set({ Authorization: `Bearer ${oldKey}` });
      expect(check3.status).toBe(401);
    });
  });

  // ─── 8. Delete connection ───
  describe("DELETE /api/v1/settings/api-keys/:id", () => {
    it("deletes a connection and returns 204", async () => {
      // Create one first
      const createRes = await request(app)
        .post("/api/v1/settings/api-keys")
        .set(sessionAuth())
        .send({ name: "To Delete", scopes: ["reviews:create"] });

      const id = createRes.body.id;

      const res = await request(app)
        .delete(`/api/v1/settings/api-keys/${id}`)
        .set(sessionAuth());

      expect(res.status).toBe(204);

      // Verify it's gone from list
      const listRes = await request(app)
        .get("/api/v1/settings/api-keys")
        .set(sessionAuth());

      const found = listRes.body.items.find((i: any) => i.id === id);
      expect(found).toBeUndefined();
    });
  });

  // ─── 9. Template scoping enforcement ───
  describe("Template scoping enforcement", () => {
    it("blocks review creation for a template not in template_ids", async () => {
      // Create a scoped connection that only has access to test-template
      const createRes = await request(app)
        .post("/api/v1/settings/api-keys")
        .set(sessionAuth())
        .send({
          name: "Scoped Only Test Template",
          scopes: ["reviews:create", "feedback:read"],
          template_ids: [template.id],
        });

      const agentKey = createRes.body.raw_key;

      // Try to create a review with other-template (not in scope)
      const reviewRes = await request(app)
        .post("/api/v1/reviews")
        .set({ Authorization: `Bearer ${agentKey}` })
        .send({
          template: "other-template",
          payload: { foo: "bar" },
          callback_url: "https://example.com/cb",
        });

      expect(reviewRes.status).toBe(403);
      expect(reviewRes.body.error.code).toBe("template_not_allowed");
    });

    it("allows review creation for a template in template_ids", async () => {
      // Create a scoped connection that has access to test-template
      const createRes = await request(app)
        .post("/api/v1/settings/api-keys")
        .set(sessionAuth())
        .send({
          name: "Scoped Allowed Agent",
          scopes: ["reviews:create"],
          template_ids: [template.id],
        });

      const agentKey = createRes.body.raw_key;

      // Create a review with test-template (in scope) - should succeed
      const reviewRes = await request(app)
        .post("/api/v1/reviews")
        .set({ Authorization: `Bearer ${agentKey}` })
        .send({
          template: "test-template",
          payload: { foo: "bar" },
          callback_url: "https://example.com/cb",
        });

      expect(reviewRes.status).toBe(201);
    });
  });

  // ─── 10. Rate limiting ───
  describe("Rate limiting", () => {
    it("enforces rate_limit_per_hour on API key", async () => {
      // Create a rate-limited connection
      const createRes = await request(app)
        .post("/api/v1/settings/api-keys")
        .set(sessionAuth())
        .send({
          name: "Rate Limited Agent",
          scopes: ["reviews:create"],
          rate_limit_per_hour: 2,
        });

      const agentKey = createRes.body.raw_key;

      // Request 1 - should succeed
      const res1 = await request(app)
        .post("/api/v1/reviews")
        .set({ Authorization: `Bearer ${agentKey}` })
        .send({
          template: "test-template",
          payload: { n: 1 },
          callback_url: "https://example.com/cb",
        });
      expect(res1.status).toBe(201);

      // Request 2 - should succeed
      const res2 = await request(app)
        .post("/api/v1/reviews")
        .set({ Authorization: `Bearer ${agentKey}` })
        .send({
          template: "test-template",
          payload: { n: 2 },
          callback_url: "https://example.com/cb",
        });
      expect(res2.status).toBe(201);

      // Request 3 - should be rate limited (429)
      const res3 = await request(app)
        .post("/api/v1/reviews")
        .set({ Authorization: `Bearer ${agentKey}` })
        .send({
          template: "test-template",
          payload: { n: 3 },
          callback_url: "https://example.com/cb",
        });
      expect(res3.status).toBe(429);
      expect(res3.body.error.code).toBe("rate_limit_exceeded");
    });
  });

  // ─── 11. Default reviewer ───
  describe("Default reviewer", () => {
    it("auto-populates assignee from default_reviewer", async () => {
      // Create a connection with default_reviewer
      const createRes = await request(app)
        .post("/api/v1/settings/api-keys")
        .set(sessionAuth())
        .send({
          name: "Default Reviewer Agent",
          scopes: ["reviews:create", "reviews:read"],
          default_reviewer: "reviewer@test.com",
        });

      const agentKey = createRes.body.raw_key;

      // Create a review without specifying assignee
      const reviewRes = await request(app)
        .post("/api/v1/reviews")
        .set({ Authorization: `Bearer ${agentKey}` })
        .send({
          template: "test-template",
          payload: { text: "needs review" },
          callback_url: "https://example.com/cb",
        });

      expect(reviewRes.status).toBe(201);
      expect(reviewRes.body.assignee).toBe("reviewer@test.com");
    });

    it("request assignee overrides default_reviewer", async () => {
      // Create a connection with default_reviewer
      const createRes = await request(app)
        .post("/api/v1/settings/api-keys")
        .set(sessionAuth())
        .send({
          name: "Default Reviewer Override Agent",
          scopes: ["reviews:create", "reviews:read"],
          default_reviewer: "reviewer@test.com",
        });

      const agentKey = createRes.body.raw_key;

      // Create a review WITH explicit assignee
      const reviewRes = await request(app)
        .post("/api/v1/reviews")
        .set({ Authorization: `Bearer ${agentKey}` })
        .send({
          template: "test-template",
          payload: { text: "needs review" },
          callback_url: "https://example.com/cb",
          assignee: "other@test.com",
        });

      expect(reviewRes.status).toBe(201);
      expect(reviewRes.body.assignee).toBe("other@test.com");
    });
  });
});

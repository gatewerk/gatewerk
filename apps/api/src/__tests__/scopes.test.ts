import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { apiKeys, templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";

describe("API Key Scopes", () => {
  let app: any;
  let fullAccessKey: string;
  let agentKey: string;
  let reviewerKey: string;
  let noScopeKey: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    // Test fixture now seeds the key with an explicit ALL_SCOPES array
    // (migration 020 removed the null-means-grandfather branch).
    fullAccessKey = seed.apiKey;

    // Create a template for tests
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "scope-test",
      project_id: seed.project.id,
      name: "Scope Test",
      fields: [{ name: "text", type: "text", label: "Text" }],
      actions: ["approve", "reject"],
    });

    // Create agent-scoped key (reviews:create, feedback:read)
    const agentRaw = "gwk_agent_scoped_key_12345";
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: seed.project.id,
      key_hash: createHash("sha256").update(agentRaw).digest("hex"),
      key_prefix: "gwk_agent",
      label: "Agent key",
      scopes: ["reviews:create", "feedback:read"],
    });
    agentKey = agentRaw;

    // Create reviewer-scoped key
    const reviewerRaw = "gwk_reviewer_scoped_key_12345";
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: seed.project.id,
      key_hash: createHash("sha256").update(reviewerRaw).digest("hex"),
      key_prefix: "gwk_revie",
      label: "Reviewer key",
      scopes: ["reviews:create", "reviews:read", "reviews:decide", "templates:read", "feedback:read"],
    });
    reviewerKey = reviewerRaw;

    // Create key with empty scopes (no permissions)
    const noScopeRaw = "gwk_noscope_key_1234567890";
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: seed.project.id,
      key_hash: createHash("sha256").update(noScopeRaw).digest("hex"),
      key_prefix: "gwk_nosco",
      label: "No scope key",
      scopes: [],
    });
    noScopeKey = noScopeRaw;

    app = createApp({ db });
  });

  const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

  describe("ALL_SCOPES key (full access)", () => {
    it("allows all endpoints when the key carries every scope", async () => {
      const res = await request(app).get("/api/v1/reviews").set(auth(fullAccessKey));
      expect(res.status).toBe(200);
    });
  });

  describe("agent-scoped key", () => {
    it("allows POST /reviews (reviews:create)", async () => {
      const res = await request(app)
        .post("/api/v1/reviews")
        .set(auth(agentKey))
        .send({
          template: "scope-test",
          payload: { text: "hello" },
          callbagwk_url: "https://example.com/cb",
        });
      expect(res.status).toBe(201);
    });

    it("allows GET /feedback (feedback:read)", async () => {
      const res = await request(app).get("/api/v1/feedback").set(auth(agentKey));
      expect(res.status).toBe(200);
    });

    it("denies GET /reviews (missing reviews:read)", async () => {
      const res = await request(app).get("/api/v1/reviews").set(auth(agentKey));
      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain("reviews:read");
    });

    it("denies GET /templates (missing templates:read)", async () => {
      const res = await request(app).get("/api/v1/templates").set(auth(agentKey));
      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain("templates:read");
    });

    it("denies GET /stats (missing stats:read)", async () => {
      const res = await request(app).get("/api/v1/stats").set(auth(agentKey));
      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain("stats:read");
    });
  });

  describe("reviewer-scoped key", () => {
    it("allows GET /reviews (reviews:read)", async () => {
      const res = await request(app).get("/api/v1/reviews").set(auth(reviewerKey));
      expect(res.status).toBe(200);
    });

    it("allows GET /templates (templates:read)", async () => {
      const res = await request(app).get("/api/v1/templates").set(auth(reviewerKey));
      expect(res.status).toBe(200);
    });

    it("denies POST /templates (missing templates:write)", async () => {
      const res = await request(app)
        .post("/api/v1/templates")
        .set(auth(reviewerKey))
        .send({ slug: "new-tpl", name: "New", fields: [{ name: "x", type: "text", label: "X" }], actions: ["approve", "reject"] });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain("templates:write");
    });

    it("denies GET /audit (missing audit:read)", async () => {
      const res = await request(app).get("/api/v1/audit").set(auth(reviewerKey));
      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain("audit:read");
    });
  });

  describe("empty scopes key (no permissions)", () => {
    it("denies everything", async () => {
      const res = await request(app).get("/api/v1/reviews").set(auth(noScopeKey));
      expect(res.status).toBe(403);
    });
  });
});

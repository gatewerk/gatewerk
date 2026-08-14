import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, webhookDeliveries } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("Review Lifecycle", () => {
  let app: any;
  let apiKey: string;
  let testDb: any;

  beforeAll(async () => {
    const { db } = await createTestDb();
    testDb = db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;

    // Create a template for tests
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "test-review",
      project_id: seed.project.id,
      name: "Test Review",
      fields: [{ name: "content", type: "text", label: "Content", editable: true }],
      actions: ["approve", "reject", "edit"],
    });

    app = createApp({ db });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  it("POST /api/v1/reviews creates a review", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "test-review",
        payload: { content: "Hello world" },
        callback_url: "https://example.com/webhook",
        priority: "high",
      });
    expect(res.status).toBe(201);
    expect(res.body.object).toBe("review");
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe("pending");
    expect(res.body.priority).toBe("high");
  });

  it("GET /api/v1/reviews lists pending reviews", async () => {
    const res = await request(app).get("/api/v1/reviews").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it("GET /api/v1/reviews?status=pending filters by status", async () => {
    const res = await request(app).get("/api/v1/reviews?status=pending").set(auth());
    expect(res.status).toBe(200);
    res.body.items.forEach((r: any) => expect(r.status).toBe("pending"));
  });

  // Inbound status filter alias (spec §11.2). When the client sends
  // 'changes_requested' OR 'awaiting_iteration', the backend expands to
  // match both during the configurable-actions transition. Once the
  // storage normalization migration runs, the alias becomes a one-line
  // passthrough.
  describe("status filter alias for changes_requested ↔ awaiting_iteration", () => {
    // Self-contained project + api-key + template + reviews. Avoids
    // seedTestProject which uses a hardcoded raw api-key that collides with
    // the outer suite's key by hash → polluted api-key lookup → outer tests
    // break.
    let aliasApiKey: string;
    let legacyReviewId: string;
    let canonicalReviewId: string;
    let pendingReviewId: string;

    beforeAll(async () => {
      const { projects, apiKeys, reviews: reviewsSchema } = await import("@gatewerk/db/src/schema/index");
      const { createHash } = await import("crypto");
      const { ALL_SCOPES } = await import("@gatewerk/shared");

      const aliasProjectId = generateId("project");
      await testDb.insert(projects).values({
        id: aliasProjectId,
        name: "Alias Suite Project",
        hmac_secret: "alias-hmac-secret",
      });

      aliasApiKey = "gwk_alias1234567890abcdef";
      const keyHash = createHash("sha256").update(aliasApiKey).digest("hex");
      await testDb.insert(apiKeys).values({
        id: generateId("api_key"),
        project_id: aliasProjectId,
        key_hash: keyHash,
        key_prefix: "gwk_alias1",
        label: "Alias suite key",
        scopes: [...ALL_SCOPES],
      });

      const aliasTemplateId = generateId("template");
      await testDb.insert(templates).values({
        id: aliasTemplateId,
        slug: "alias-test",
        project_id: aliasProjectId,
        name: "Alias Test",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: ["approve", "reject"],
      });

      // Seed three canonical reviews. Post-migration-033, storage no longer
      // permits 'changes_requested' (CHECK rejects it) — both seeded
      // iteration rows are 'awaiting_iteration'. The alias test still
      // verifies the inbound INPUT translation: ?status=changes_requested
      // schema-validates via DEPRECATED_REVIEW_STATUSES and translates to
      // an inArray match against canonical storage. Both filter directions
      // surface the same set of canonical iteration rows.
      legacyReviewId = generateId("review");
      canonicalReviewId = generateId("review");
      pendingReviewId = generateId("review");
      await testDb.insert(reviewsSchema).values([
        {
          id: legacyReviewId,
          project_id: aliasProjectId,
          template_id: aliasTemplateId,
          template_slug: "alias-test",
          payload: { content: "first iteration row" },
          status: "awaiting_iteration",
        },
        {
          id: canonicalReviewId,
          project_id: aliasProjectId,
          template_id: aliasTemplateId,
          template_slug: "alias-test",
          payload: { content: "second iteration row" },
          status: "awaiting_iteration",
        },
        {
          id: pendingReviewId,
          project_id: aliasProjectId,
          template_id: aliasTemplateId,
          template_slug: "alias-test",
          payload: { content: "pending review" },
          status: "pending",
        },
      ]);
    });

    const aliasAuth = () => ({ Authorization: `Bearer ${aliasApiKey}` });

    it("expands either iteration filter to match both shapes; unrelated filters unaffected", async () => {
      // Canonical filter should return both iteration rows.
      const canonicalRes = await request(app)
        .get("/api/v1/reviews?status=awaiting_iteration")
        .set(aliasAuth());
      expect(canonicalRes.status).toBe(200);
      const canonicalIds = new Set(canonicalRes.body.items.map((r: any) => r.id));
      expect(canonicalIds.has(legacyReviewId)).toBe(true);
      expect(canonicalIds.has(canonicalReviewId)).toBe(true);
      expect(canonicalIds.has(pendingReviewId)).toBe(false);

      // Legacy filter should also return both iteration rows.
      const legacyRes = await request(app)
        .get("/api/v1/reviews?status=changes_requested")
        .set(aliasAuth());
      expect(legacyRes.status).toBe(200);
      const legacyIds = new Set(legacyRes.body.items.map((r: any) => r.id));
      expect(legacyIds.has(legacyReviewId)).toBe(true);
      expect(legacyIds.has(canonicalReviewId)).toBe(true);
      expect(legacyIds.has(pendingReviewId)).toBe(false);

      // Unrelated filter still works literally — no iteration leaks.
      const pendingRes = await request(app)
        .get("/api/v1/reviews?status=pending")
        .set(aliasAuth());
      expect(pendingRes.status).toBe(200);
      const pendingIds = new Set(pendingRes.body.items.map((r: any) => r.id));
      expect(pendingIds.has(pendingReviewId)).toBe(true);
      expect(pendingIds.has(legacyReviewId)).toBe(false);
      expect(pendingIds.has(canonicalReviewId)).toBe(false);
    });
  });

  describe("GET /api/v1/reviews offset pagination", () => {
    let paginApiKey: string;

    beforeAll(async () => {
      const { projects: projectsT, apiKeys: apiKeysT, reviews: reviewsT } =
        await import("@gatewerk/db/src/schema/index");
      const { createHash } = await import("crypto");
      const { ALL_SCOPES: allScopes } = await import("@gatewerk/shared");

      const projectId = generateId("project");
      await testDb.insert(projectsT).values({
        id: projectId, name: "Pagination Project", hmac_secret: "pagin-hmac-secret",
      });

      paginApiKey = "gwk_pagin1234567890abcdef";
      await testDb.insert(apiKeysT).values({
        id: generateId("api_key"),
        project_id: projectId,
        key_hash: createHash("sha256").update(paginApiKey).digest("hex"),
        key_prefix: "gwk_pagin1",
        label: "Pagination key",
        scopes: [...allScopes],
      });

      const templateId = generateId("template");
      await testDb.insert(templates).values({
        id: templateId,
        slug: "pagin-test",
        project_id: projectId,
        name: "Pagination Test",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: ["approve", "reject"],
      });

      const ids = Array.from({ length: 5 }, () => generateId("review"));
      await testDb.insert(reviewsT).values(
        ids.map((id) => ({
          id, project_id: projectId, template_id: templateId,
          template_slug: "pagin-test", payload: { content: `review ${id}` }, status: "pending",
        })),
      );
    });

    const paginAuth = () => ({ Authorization: `Bearer ${paginApiKey}` });

    it("?limit=3&offset=0 returns 3 items and has_more=true", async () => {
      const res = await request(app).get("/api/v1/reviews?limit=3&offset=0").set(paginAuth());
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(3);
      expect(res.body.has_more).toBe(true);
    });

    it("?limit=3&offset=3 returns 2 items, has_more=false, disjoint from first page", async () => {
      const page1 = await request(app).get("/api/v1/reviews?limit=3&offset=0").set(paginAuth());
      const page2 = await request(app).get("/api/v1/reviews?limit=3&offset=3").set(paginAuth());
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(2);
      expect(page2.body.has_more).toBe(false);
      const page1Ids = new Set(page1.body.items.map((r: any) => r.id));
      page2.body.items.forEach((r: any) => expect(page1Ids.has(r.id)).toBe(false));
    });
  });

  it("GET /api/v1/reviews embeds template metadata in every row", async () => {
    const res = await request(app).get("/api/v1/reviews").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    const withTpl = res.body.items.find((r: any) => r.template_id);
    expect(withTpl).toBeDefined();
    expect(withTpl.template).toBeDefined();
    expect(withTpl.template).not.toBeNull();
    expect(withTpl.template.id).toBe(withTpl.template_id);
    expect(withTpl.template.slug).toBe(withTpl.template_slug);
    expect(withTpl.template.name).toBe("Test Review");
    expect(Array.isArray(withTpl.template.fields)).toBe(true);
    expect(Array.isArray(withTpl.template.actions)).toBe(true);
    // Enrichment — editable normalized to boolean on every field
    withTpl.template.fields.forEach((f: any) => {
      expect(typeof f.editable).toBe("boolean");
    });
  });

  it("GET /api/v1/reviews emits template === null for rows without a template_id", async () => {
    // Insert a review directly bypassing the service (which requires a template)
    const { reviews: reviewsTable } = await import("@gatewerk/db/src/schema/index");
    const orphanId = generateId("review");
    // Use the same project_id seeded earlier via the auth key.
    const [anyRow] = await testDb.select().from(reviewsTable).limit(1);
    await testDb.insert(reviewsTable).values({
      id: orphanId,
      project_id: anyRow.project_id,
      template_id: null,
      template_slug: "orphan",
      payload: { content: "orphan" },
      suggested_value: { content: "orphan" },
      priority: "normal",
      actions: ["approve", "reject"],
      status: "pending",
      current_version: 1,
    });

    const res = await request(app).get("/api/v1/reviews").set(auth());
    expect(res.status).toBe(200);
    const orphan = res.body.items.find((r: any) => r.id === orphanId);
    expect(orphan).toBeDefined();
    expect(orphan.template_id).toBeNull();
    expect(orphan.template).toBeNull();
  });

  it("GET /api/v1/reviews/:id returns review details", async () => {
    const create = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "test-review",
        payload: { content: "Detail test" },
        callback_url: "https://example.com/webhook",
      });

    const res = await request(app)
      .get(`/api/v1/reviews/${create.body.id}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("review");
    expect(res.body.payload.content).toBe("Detail test");
  });

  it("GET /api/v1/reviews/:id emits template embed matching the list item shape", async () => {
    const create = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "test-review",
        payload: { content: "Shape parity" },
      });

    const detailRes = await request(app)
      .get(`/api/v1/reviews/${create.body.id}`)
      .set(auth());
    const listRes = await request(app).get("/api/v1/reviews").set(auth());
    const listItem = listRes.body.items.find((r: any) => r.id === create.body.id);

    // Invariant lock: detail and list now return identical shape for the same review.
    expect(detailRes.body.template).toBeDefined();
    expect(detailRes.body.template).not.toBeNull();
    expect(detailRes.body.template.id).toBe(detailRes.body.template_id);
    expect(detailRes.body.template.slug).toBe("test-review");
    expect(detailRes.body.template).toEqual(listItem.template);
  });

  it("mutation responses always include the template key (null or populated)", async () => {
    // decide/retry/archive etc don't leftJoin template — route layer normalizer must inject
    // `template: null` so ReviewObjectSchema's tightened contract holds everywhere.
    const create = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: "test-review", payload: { content: "Mutation shape" } });

    // Create response — pre-decided path returns raw review (no leftJoin)
    expect(create.body).toHaveProperty("template");
    expect(create.body.template === null || typeof create.body.template === "object").toBe(true);

    const decide = await request(app)
      .post(`/api/v1/reviews/${create.body.id}/decide`)
      .set(auth())
      .send({ decision: "approved" });
    expect(decide.body).toHaveProperty("template");
    expect(decide.body.template === null || typeof decide.body.template === "object").toBe(true);
  });

  // Task 2: iteration_count serialization assertions.
  it("POST create response includes iteration_count=0 (first version)", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: "test-review", payload: { content: "iter-count-create" } });
    expect(res.status).toBe(201);
    expect(res.body.current_version).toBe(1);
    expect(res.body.iteration_count).toBe(0);
  });

  it("GET /api/v1/reviews list items include iteration_count", async () => {
    const create = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: "test-review", payload: { content: "iter-count-list" } });

    const list = await request(app).get("/api/v1/reviews").set(auth());
    const item = list.body.items.find((r: any) => r.id === create.body.id);
    expect(item).toBeDefined();
    expect(item.iteration_count).toBe(0); // version 1 → 0 retries
  });

  it("GET /api/v1/reviews/:id includes iteration_count", async () => {
    const create = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: "test-review", payload: { content: "iter-count-detail" } });

    const detail = await request(app).get(`/api/v1/reviews/${create.body.id}`).set(auth());
    expect(detail.status).toBe(200);
    expect(detail.body.iteration_count).toBe(0);
  });

  it("iteration_count increments after retry + version bump", async () => {
    const create = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "test-review",
        payload: { content: "Version 1" },
        callback_url: "https://example.com/webhook",
      });
    expect(create.body.iteration_count).toBe(0);

    // Reviewer requests changes (version → 2)
    await request(app)
      .post(`/api/v1/reviews/${create.body.id}/retry`)
      .set(auth())
      .send({ feedback: "Needs revision" });

    // Agent submits updated version
    const updated = await request(app)
      .put(`/api/v1/reviews/${create.body.id}`)
      .set(auth())
      .send({ payload: { content: "Version 2" }, version: 2 });
    expect(updated.status).toBe(200);
    expect(updated.body.current_version).toBe(2);
    expect(updated.body.iteration_count).toBe(1);

    // GET detail also reflects updated iteration_count
    const detail = await request(app).get(`/api/v1/reviews/${create.body.id}`).set(auth());
    expect(detail.body.iteration_count).toBe(1);

    // List also reflects it
    const list = await request(app).get("/api/v1/reviews").set(auth());
    const item = list.body.items.find((r: any) => r.id === create.body.id);
    expect(item?.iteration_count).toBe(1);
  });

  it("decide response includes iteration_count", async () => {
    const create = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: "test-review", payload: { content: "decide-iter-count" } });

    const decide = await request(app)
      .post(`/api/v1/reviews/${create.body.id}/decide`)
      .set(auth())
      .send({ decision: "approved" });
    expect(decide.status).toBe(200);
    expect(decide.body.iteration_count).toBe(0);
  });

  // Frozen-contract consistency: a v1 decision's STORED webhook payload must
  // carry iteration_count=0 (always-present, not omitted). Locks the
  // execute-action caller's always-include behavior.
  it("stored review.decided payload carries iteration_count=0 on a first-version decide", async () => {
    const create = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "test-review",
        payload: { content: "v1-stored-iter-count" },
        callback_url: "https://example.com/webhook-v1-iter",
      });
    const reviewId = create.body.id;

    const decide = await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set(auth())
      .send({ decision: "approved" });
    expect(decide.status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));

    const rows = await testDb
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.review_id, reviewId));
    const decidedRow = rows.find((r: { event_type: string }) => r.event_type === "review.decided");
    expect(decidedRow).toBeDefined();
    expect((decidedRow!.payload as Record<string, unknown>).iteration_count).toBe(0);
  });

  it("POST /api/v1/reviews/:id/decide marks review as decided", async () => {
    const create = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "test-review",
        payload: { content: "Decide test" },
        callback_url: "https://example.com/webhook",
      });

    const res = await request(app)
      .post(`/api/v1/reviews/${create.body.id}/decide`)
      .set(auth())
      .send({
        decision: "approved",
        feedback: "Looks good",
        reviewer: "test@example.com",
      });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("approved");
    expect(res.body.status).toBe("decided");
  });

  it("rejects deciding on already-decided review (409)", async () => {
    const create = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "test-review",
        payload: { content: "Double decide" },
        callback_url: "https://example.com/webhook",
      });

    await request(app)
      .post(`/api/v1/reviews/${create.body.id}/decide`)
      .set(auth())
      .send({ decision: "approved" });

    const res = await request(app)
      .post(`/api/v1/reviews/${create.body.id}/decide`)
      .set(auth())
      .send({ decision: "rejected" });
    expect(res.status).toBe(409);
  });

  it("concurrent decides race safely: exactly one success, one 409, one webhook delivery", async () => {
    // The state guard is enforced by the UPDATE ... WHERE status='pending' in
    // reviewService.decide(). This test exercises the race path explicitly —
    // slow-double-click tests above verify the sequential case, but only a
    // parallel fire covers genuine concurrent-writer ordering.
    const create = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "test-review",
        payload: { content: "Race test" },
        callback_url: "https://example.com/webhook-race",
      });
    const reviewId = create.body.id;

    const [a, b] = await Promise.all([
      request(app).post(`/api/v1/reviews/${reviewId}/decide`).set(auth()).send({ decision: "approved" }),
      request(app).post(`/api/v1/reviews/${reviewId}/decide`).set(auth()).send({ decision: "rejected" }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = a.status === 409 ? a : b;
    expect(loser.body?.error?.code).toBe("review_already_decided");

    // Let the fire-and-forget webhook dispatch flush before counting rows.
    // 200ms is generous — createDelivery is a single INSERT against pglite.
    await new Promise((r) => setTimeout(r, 200));

    const rows = await testDb
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.review_id, reviewId));

    // Two delivery rows from the winner: the new dispatcher dual-fires
    // review.action_taken (canonical, spec §9.1) AND review.decided (legacy
    // compat, spec §9.2) for one-minor-version backwards compatibility. The
    // loser never reaches dispatchActionWebhooks because its UPDATE returned
    // 0 rows and threw review_already_decided pre-dispatch.
    expect(rows).toHaveLength(2);
    const eventTypes = rows.map((r: { event_type: string }) => r.event_type).sort();
    expect(eventTypes).toEqual(["review.action_taken", "review.decided"]);
  });

  it("returns 400 for unknown template slug", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "nonexistent",
        payload: { content: "test" },
        callback_url: "https://example.com/webhook",
      });
    expect(res.status).toBe(400);
  });

  it("POST /api/v1/reviews/:id/retry keeps review pending", async () => {
    const create = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "test-review",
        payload: { content: "Retry test" },
        callback_url: "https://example.com/webhook",
      });

    const res = await request(app)
      .post(`/api/v1/reviews/${create.body.id}/retry`)
      .set(auth())
      .send({
        feedback: "Too generic",
        prompt_edit: "Be more specific",
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("awaiting_iteration");
  });

  it("PUT /api/v1/reviews/:id updates with new version", async () => {
    const create = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "test-review",
        payload: { content: "Version 1" },
        callback_url: "https://example.com/webhook",
      });

    // First request changes so the review is in "awaiting_iteration" status
    // (configurable-actions Phase 2 commit 5 migrated retry's WRITE path to
    // canonical; legacy "changes_requested" status is now read-tolerated only,
    // not produced by new writes).
    await request(app)
      .post(`/api/v1/reviews/${create.body.id}/retry`)
      .set(auth())
      .send({
        feedback: "Needs improvement",
        prompt_edit: "Be more specific",
      });

    const res = await request(app)
      .put(`/api/v1/reviews/${create.body.id}`)
      .set(auth())
      .send({
        payload: { content: "Version 2 — improved" },
        version: 2,
      });
    expect(res.status).toBe(200);
    expect(res.body.current_version).toBe(2);
    expect(res.body.payload.content).toBe("Version 2 — improved");
  });

  // Task 2: E2E callback assertion — iteration_count in stored webhook_deliveries.payload.
  // Flow: create (v=1) → retry (→awaiting_iteration, v=1) → agent PUT version=2 (v=2)
  // → decide (v=2). At decide time, iteration_count = current_version - 1 = 1.
  it("stored webhook_deliveries.payload carries iteration_count=1 after retry + agent-submit + decide", async () => {
    // 1. Create review (version=1)
    const create = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "test-review",
        payload: { content: "E2E iter count" },
        callback_url: "https://example.com/webhook-e2e",
      });
    expect(create.status).toBe(201);
    const reviewId = create.body.id;
    expect(create.body.current_version).toBe(1);
    expect(create.body.iteration_count).toBe(0);

    // 2. Reviewer requests changes (status→awaiting_iteration; v still=1).
    const retry = await request(app)
      .post(`/api/v1/reviews/${reviewId}/retry`)
      .set(auth())
      .send({ feedback: "Please revise" });
    expect(retry.status).toBe(200);

    // 3. Agent submits revised payload → version bumps to 2.
    const agentPut = await request(app)
      .put(`/api/v1/reviews/${reviewId}`)
      .set(auth())
      .send({ payload: { content: "E2E iter count revised" }, version: 2 });
    expect(agentPut.status).toBe(200);
    expect(agentPut.body.current_version).toBe(2);
    expect(agentPut.body.iteration_count).toBe(1);

    // 4. Reviewer decides (current_version=2 → iteration_count=1 in callback).
    const decide = await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set(auth())
      .send({ decision: "approved" });
    expect(decide.status).toBe(200);
    expect(decide.body.iteration_count).toBe(1);

    // Wait for fire-and-forget webhook dispatch to flush (generous budget).
    await new Promise((r) => setTimeout(r, 200));

    // 5. Assert iteration_count=1 is in the stored review.decided delivery payload.
    const rows = await testDb
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.review_id, reviewId));

    const decidedRow = rows.find((r: { event_type: string }) => r.event_type === "review.decided");
    expect(decidedRow).toBeDefined();
    const payload = decidedRow!.payload as Record<string, unknown>;
    expect(payload.iteration_count).toBe(1);
  });
});

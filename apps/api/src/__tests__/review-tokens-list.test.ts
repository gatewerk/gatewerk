import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createHash } from "crypto";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import {
  apiKeys,
  projects,
  reviews,
  reviewTokens,
  templates,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

// Token-history-panel (spec §3 + §5 + §7). Integration coverage for
// GET /api/v1/reviews/:id/tokens. seedTestProject is called once
// (repeat calls collide on its fixed seed keys); the cross-project + limited-scope
// fixtures are raw-inserted with unique key prefixes.
describe("GET /api/v1/reviews/:id/tokens", () => {
  let app: any;
  let client: any;
  let db: any;
  let apiKey: string;
  let projectId: string;
  let templateId: string;
  let templateSlug: string;

  // Cross-project fixture (test 11) — separate project + its own api-key.
  let otherApiKey: string;

  // Limited-scope fixture (test 10) — same project, templates:read only.
  let limitedApiKey: string;

  async function createPendingReview(): Promise<string> {
    const [rev] = await db
      .insert(reviews)
      .values({
        id: generateId("review"),
        project_id: projectId,
        template_id: templateId,
        template_slug: templateSlug,
        payload: { subject: "fresh" },
        callback_url: "https://example.com/cb",
        status: "pending",
      })
      .returning();
    return rev.id;
  }

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;

    const [tpl] = await db
      .insert(templates)
      .values({
        id: generateId("template"),
        slug: "token-list-test",
        project_id: projectId,
        name: "Token List Test",
        fields: [{ name: "subject", type: "text", label: "Subject" }],
        actions: ["approve", "reject"],
        enable_review_links: true,
      })
      .returning();
    templateId = tpl.id;
    templateSlug = tpl.slug;

    const limitedRaw = "gwk_tlist1ltd4567890abcdef";
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: projectId,
      key_hash: createHash("sha256").update(limitedRaw).digest("hex"),
      key_prefix: "gwk_tlis",
      label: "Limited (templates:read only)",
      scopes: ["templates:read"],
    });
    limitedApiKey = limitedRaw;

    const [otherProj] = await db
      .insert(projects)
      .values({
        id: generateId("project"),
        name: "Other Project",
        hmac_secret: "other-hmac",
      })
      .returning();
    const otherRaw = "gwk_tlist1other67890abcdef";
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: otherProj.id,
      key_hash: createHash("sha256").update(otherRaw).digest("hex"),
      key_prefix: "gwk_tlis",
      label: "Other project key",
      scopes: ["reviews:read", "reviews:create", "reviews:decide", "templates:read"],
    });
    otherApiKey = otherRaw;

    app = createApp({ db });
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("(1) returns empty list for a review with no tokens", async () => {
    const reviewId = await createPendingReview();
    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}/tokens`)
      .set("Authorization", `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0, has_more: false });
  });

  it("(2) marks an active token with status='active'", async () => {
    const reviewId = await createPendingReview();
    await request(app)
      .post(`/api/v1/reviews/${reviewId}/token`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ purpose: "active", recipient_label: "alice" });

    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}/tokens`)
      .set("Authorization", `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].status).toBe("active");
    expect(res.body.items[0].recipient_label).toBe("alice");
    expect(res.body.items[0].auth_level).toBe("public");
    expect(res.body.items[0].used_at).toBeNull();
    expect(res.body.items[0].revoked_at).toBeNull();
    expect(res.body.total).toBe(1);
    expect(res.body.has_more).toBe(false);
  });

  it("(3) approved token surfaces status='approved' + decision='approved'", async () => {
    const reviewId = await createPendingReview();
    const genRes = await request(app)
      .post(`/api/v1/reviews/${reviewId}/token`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ purpose: "approve", recipient_label: "bob" });
    const token = genRes.body.token;
    const decideRes = await request(app)
      .post(`/r/${token}/decide`)
      .send({ decision: "approved" });
    // Defense-in-depth against future preset config changes silently
    // breaking the decide path while leaving the token row stamped via
    // a partial-write atomicity violation (see /decide preflight +
    // compensating revert). Approve does not require feedback today.
    expect(decideRes.status).toBe(200);

    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}/tokens`)
      .set("Authorization", `Bearer ${apiKey}`);

    expect(res.body.items[0].status).toBe("approved");
    expect(res.body.items[0].decision).toBe("approved");
    expect(res.body.items[0].used_at).not.toBeNull();
  });

  it("(4) rejected token surfaces status='rejected'", async () => {
    const reviewId = await createPendingReview();
    const genRes = await request(app)
      .post(`/api/v1/reviews/${reviewId}/token`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ purpose: "reject", recipient_label: "carol" });
    const token = genRes.body.token;
    // Reject preset has requires_feedback: true; without feedback the
    // action layer throws InvalidRequestError and the route's
    // compensating revert undoes the consume stamp — so the assertion
    // below would observe status='active'. The earlier shape passed
    // only because consume stamped the token before the throw bubbled
    // (the same atomicity violation /decide's preflight + revert was
    // introduced to fix). Sending feedback here exercises the path the
    // test name claims to verify.
    const decideRes = await request(app)
      .post(`/r/${token}/decide`)
      .send({ decision: "rejected", feedback: "no thanks" });
    expect(decideRes.status).toBe(200);

    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}/tokens`)
      .set("Authorization", `Bearer ${apiKey}`);

    expect(res.body.items[0].status).toBe("rejected");
  });

  it("(5) revoked token surfaces status='revoked' + revoked_by", async () => {
    const reviewId = await createPendingReview();
    await request(app)
      .post(`/api/v1/reviews/${reviewId}/token`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ purpose: "to-be-revoked", recipient_label: "dan" });
    await request(app)
      .post(`/api/v1/reviews/${reviewId}/token/revoke`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({});

    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}/tokens`)
      .set("Authorization", `Bearer ${apiKey}`);

    expect(res.body.items[0].status).toBe("revoked");
    expect(res.body.items[0].revoked_at).toBeTruthy();
    expect(res.body.items[0].revoked_by).toBeTruthy();
  });

  it("(6) expired token (past expires_at, never used) surfaces status='expired'", async () => {
    const reviewId = await createPendingReview();
    await request(app)
      .post(`/api/v1/reviews/${reviewId}/token`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ purpose: "to-expire", recipient_label: "eve" });
    await db
      .update(reviewTokens)
      .set({ expires_at: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(reviewTokens.review_id, reviewId));

    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}/tokens`)
      .set("Authorization", `Bearer ${apiKey}`);

    expect(res.body.items[0].status).toBe("expired");
  });

  it("(7) non-canonical decision rolls up to status='completed' (forward-compat)", async () => {
    const reviewId = await createPendingReview();
    await request(app)
      .post(`/api/v1/reviews/${reviewId}/token`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ purpose: "edit-flow", recipient_label: "frank" });
    // The /r/:token/decide route is constrained to the canonical decision
    // enum; configurable-actions Phase 4 widens the surface. We're testing
    // the status-derivation contract here, not the route, so stamp the row
    // directly with a forward-compat decision value.
    await db
      .update(reviewTokens)
      .set({ used_at: new Date(), decision: "edited" })
      .where(eq(reviewTokens.review_id, reviewId));

    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}/tokens`)
      .set("Authorization", `Bearer ${apiKey}`);

    expect(res.body.items[0].status).toBe("completed");
    expect(res.body.items[0].decision).toBe("edited");
  });

  it("(8) returns rows newest-first by created_at DESC", async () => {
    const reviewId = await createPendingReview();
    const now = Date.now();
    await db.insert(reviewTokens).values([
      {
        id: generateId("token"),
        token_hash: createHash("sha256").update("oldest").digest("hex"),
        review_id: reviewId,
        project_id: projectId,
        expires_at: new Date(now + 86400_000),
        purpose: "p1",
        recipient_label: "oldest",
        auth_level: "public",
        created_by_kind: "manual",
        created_by_id: "u1",
        created_at: new Date(now - 3000),
      },
      {
        id: generateId("token"),
        token_hash: createHash("sha256").update("middle").digest("hex"),
        review_id: reviewId,
        project_id: projectId,
        expires_at: new Date(now + 86400_000),
        purpose: "p2",
        recipient_label: "middle",
        auth_level: "public",
        created_by_kind: "manual",
        created_by_id: "u1",
        created_at: new Date(now - 2000),
      },
      {
        id: generateId("token"),
        token_hash: createHash("sha256").update("newest").digest("hex"),
        review_id: reviewId,
        project_id: projectId,
        expires_at: new Date(now + 86400_000),
        purpose: "p3",
        recipient_label: "newest",
        auth_level: "public",
        created_by_kind: "manual",
        created_by_id: "u1",
        created_at: new Date(now - 1000),
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}/tokens`)
      .set("Authorization", `Bearer ${apiKey}`);

    expect(res.body.items.map((r: any) => r.recipient_label)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("(9) paginates correctly: limit=10 offset=20 over 25 rows", async () => {
    const reviewId = await createPendingReview();
    const now = Date.now();
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: generateId("token"),
      token_hash: createHash("sha256").update(`page-${i}`).digest("hex"),
      review_id: reviewId,
      project_id: projectId,
      expires_at: new Date(now + 86400_000),
      purpose: "page",
      recipient_label: `r-${i}`,
      auth_level: "public" as const,
      created_by_kind: "manual" as const,
      created_by_id: "u1",
      created_at: new Date(now - (25 - i) * 1000),
    }));
    await db.insert(reviewTokens).values(rows);

    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}/tokens?limit=10&offset=20`)
      .set("Authorization", `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(25);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.has_more).toBe(false);
  });

  it("(10) rejects an api-key without reviews:read with 403", async () => {
    const reviewId = await createPendingReview();
    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}/tokens`)
      .set("Authorization", `Bearer ${limitedApiKey}`);

    expect(res.status).toBe(403);
  });

  it("(11) returns 404 when querying a foreign project's review", async () => {
    const reviewId = await createPendingReview();
    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}/tokens`)
      .set("Authorization", `Bearer ${otherApiKey}`);

    expect(res.status).toBe(404);
  });

  it("(12) revoked dominates used in status precedence", async () => {
    const reviewId = await createPendingReview();
    const now = new Date();
    await db.insert(reviewTokens).values({
      id: generateId("token"),
      token_hash: createHash("sha256").update("race").digest("hex"),
      review_id: reviewId,
      project_id: projectId,
      expires_at: new Date(Date.now() + 86400_000),
      purpose: "race",
      recipient_label: "race",
      auth_level: "public",
      created_by_kind: "manual",
      created_by_id: "u1",
      used_at: now,
      revoked_at: now,
      revoked_by: "ops",
      decision: "approved",
    });

    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}/tokens`)
      .set("Authorization", `Bearer ${apiKey}`);

    expect(res.body.items[0].status).toBe("revoked");
  });
});

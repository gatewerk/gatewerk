import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { projects, templates, reviews, webhookDeliveries } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("GET /api/v1/webhooks/deliveries", () => {
  let app: any;
  let apiKey: string;
  let reviewId: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;

    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "wd-route-tpl",
      project_id: seed.project.id,
      name: "WD Route Test",
      fields: [{ name: "text", type: "text", label: "Text" }],
      actions: ["approve", "reject"],
    }).returning();

    const [rev] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: seed.project.id,
      template_id: tpl.id,
      template_slug: "wd-route-tpl",
      payload: { text: "hello" },
      callback_url: "https://example.com/cb",
    }).returning();
    reviewId = rev.id;

    // Insert test deliveries (no hmac_secret — column dropped in migration 057)
    await db.insert(webhookDeliveries).values([
      {
        id: generateId("delivery"),
        review_id: reviewId,
        event_type: "review.decided",
        url: "https://agent.example.com/cb",
        payload: { type: "review.decided", review_id: reviewId, decision: "approved" },
        status: "delivered",
        attempts: 1,
        max_attempts: 5,
        delivered_at: new Date(),
      },
      {
        id: generateId("delivery"),
        review_id: reviewId,
        event_type: "review.retried",
        url: "https://agent.example.com/cb",
        payload: { type: "review.retried", review_id: reviewId },
        status: "pending",
        attempts: 2,
        max_attempts: 5,
        last_error: "Connection refused",
        next_attempt_at: new Date(Date.now() + 60000),
      },
    ]);

    app = createApp({ db });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  it("returns delivery history", async () => {
    const res = await request(app)
      .get("/api/v1/webhooks/deliveries")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(res.body.items.length).toBe(2);
    expect(res.body.items[0].object).toBe("webhook_delivery");
    // Ensure hmac_secret is NOT exposed
    expect(res.body.items[0].hmac_secret).toBeUndefined();
  });

  it("filters by review_id", async () => {
    const res = await request(app)
      .get(`/api/v1/webhooks/deliveries?review_id=${reviewId}`)
      .set(auth());

    expect(res.status).toBe(200);
    res.body.items.forEach((d: any) => expect(d.review_id).toBe(reviewId));
  });

  it("filters by status", async () => {
    const res = await request(app)
      .get("/api/v1/webhooks/deliveries?status=delivered")
      .set(auth());

    expect(res.status).toBe(200);
    res.body.items.forEach((d: any) => expect(d.status).toBe("delivered"));
    expect(res.body.items.length).toBe(1);
  });

  it("filters by event_type — single value and repeated (any-of) values", async () => {
    const single = await request(app)
      .get("/api/v1/webhooks/deliveries?event_type=review.retried")
      .set(auth());
    expect(single.status).toBe(200);
    expect(single.body.items.length).toBe(1);
    expect(single.body.items[0].event_type).toBe("review.retried");

    // Repeated `event_type=` params — Express parses these into an array,
    // same contract as /audit's `action` filter.
    const multi = await request(app)
      .get("/api/v1/webhooks/deliveries?event_type=review.decided&event_type=review.retried")
      .set(auth());
    expect(multi.status).toBe(200);
    expect(multi.body.items.length).toBe(2);

    const none = await request(app)
      .get("/api/v1/webhooks/deliveries?event_type=review.expired")
      .set(auth());
    expect(none.status).toBe(200);
    expect(none.body.items.length).toBe(0);
  });

  it("filters by from/to date range", async () => {
    // Excludes everything when `from` is set to well after both seeded rows.
    const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const noneAfter = await request(app)
      .get(`/api/v1/webhooks/deliveries?from=${encodeURIComponent(future)}`)
      .set(auth());
    expect(noneAfter.status).toBe(200);
    expect(noneAfter.body.items.length).toBe(0);

    // Includes both seeded rows when `to` is set well after them.
    const allBefore = await request(app)
      .get(`/api/v1/webhooks/deliveries?to=${encodeURIComponent(future)}`)
      .set(auth());
    expect(allBefore.status).toBe(200);
    expect(allBefore.body.items.length).toBe(2);

    // Excludes everything when `to` is set well before both seeded rows.
    const past = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const noneBefore = await request(app)
      .get(`/api/v1/webhooks/deliveries?to=${encodeURIComponent(past)}`)
      .set(auth());
    expect(noneBefore.status).toBe(200);
    expect(noneBefore.body.items.length).toBe(0);
  });

  it("requires API key auth", async () => {
    const res = await request(app)
      .get("/api/v1/webhooks/deliveries");

    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/webhooks/deliveries/:id/retry", () => {
  let app: any;
  let db: any;
  let apiKey: string;
  let pendingDeliveryId: string;
  let deliveredDeliveryId: string;
  let otherProjectDeliveryId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;

    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "wd-retry-tpl",
      project_id: seed.project.id,
      name: "WD Retry Test",
      fields: [{ name: "text", type: "text", label: "Text" }],
      actions: ["approve", "reject"],
    }).returning();

    const [rev] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: seed.project.id,
      template_id: tpl.id,
      template_slug: "wd-retry-tpl",
      payload: { text: "hello" },
      callback_url: "https://example.com/cb",
    }).returning();

    // Pending delivery — can be retried
    const [pd] = await db.insert(webhookDeliveries).values({
      id: generateId("delivery"),
      review_id: rev.id,
      event_type: "review.decided",
      url: "https://agent.example.com/cb",
      payload: { type: "review.decided", review_id: rev.id },
      status: "failed",
      attempts: 3,
      max_attempts: 5,
      last_error: "Connection refused",
    }).returning();
    pendingDeliveryId = pd.id;

    // Already-delivered delivery
    const [dd] = await db.insert(webhookDeliveries).values({
      id: generateId("delivery"),
      review_id: rev.id,
      event_type: "review.decided",
      url: "https://agent.example.com/cb",
      payload: { type: "review.decided", review_id: rev.id },
      status: "delivered",
      attempts: 1,
      max_attempts: 5,
      delivered_at: new Date(),
    }).returning();
    deliveredDeliveryId = dd.id;

    // Other project (no API key — created manually to avoid the shared
    // rawKey collision in seedTestProject which would make auth resolve to
    // the wrong project and break ownership-check tests).
    const [otherProject] = await db.insert(projects).values({
      id: generateId("project"),
      name: "Other Project",
      hmac_secret: "other-hmac-secret",
    }).returning();
    const [otherTpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "wd-retry-other",
      project_id: otherProject.id,
      name: "Other Tpl",
      fields: [],
      actions: ["approve"],
    }).returning();
    const [otherRev] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: otherProject.id,
      template_id: otherTpl.id,
      template_slug: "wd-retry-other",
      payload: {},
      callback_url: "https://example.com/cb",
    }).returning();
    const [od] = await db.insert(webhookDeliveries).values({
      id: generateId("delivery"),
      review_id: otherRev.id,
      event_type: "review.decided",
      url: "https://agent.example.com/cb",
      payload: {},
      status: "failed",
      attempts: 1,
      max_attempts: 5,
    }).returning();
    otherProjectDeliveryId = od.id;

    app = createApp({ db });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  it("returns 200 with status:pending and does NOT bump attempts", async () => {
    const before = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, pendingDeliveryId)).limit(1);
    const attemptsBefore = before[0].attempts;

    const res = await request(app)
      .post(`/api/v1/webhooks/deliveries/${pendingDeliveryId}/retry`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(res.body.id).toBe(pendingDeliveryId);
    expect(res.body.queued_at).toBeTruthy();

    // Attempts must NOT be bumped — the worker owns the counter
    const after = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, pendingDeliveryId)).limit(1);
    expect(after[0].attempts).toBe(attemptsBefore);
  });

  it("returns 400 when status is already delivered", async () => {
    const res = await request(app)
      .post(`/api/v1/webhooks/deliveries/${deliveredDeliveryId}/retry`)
      .set(auth());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("already_delivered");
  });

  it("returns 404 for a delivery belonging to a different project", async () => {
    const res = await request(app)
      .post(`/api/v1/webhooks/deliveries/${otherProjectDeliveryId}/retry`)
      .set(auth());

    expect(res.status).toBe(404);
  });

  it("returns 404 for a non-existent delivery id", async () => {
    const res = await request(app)
      .post(`/api/v1/webhooks/deliveries/gw_del_nonexistent/retry`)
      .set(auth());

    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post(`/api/v1/webhooks/deliveries/${pendingDeliveryId}/retry`);

    expect(res.status).toBe(401);
  });

  it("returns 409 when claimed_by is set (worker race)", async () => {
    // Simulate worker claiming the delivery
    await db
      .update(webhookDeliveries)
      .set({ claimed_by: "worker-1", status: "pending" })
      .where(eq(webhookDeliveries.id, pendingDeliveryId));

    const res = await request(app)
      .post(`/api/v1/webhooks/deliveries/${pendingDeliveryId}/retry`)
      .set(auth());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("delivery_claimed");

    // Restore for subsequent test runs
    await db
      .update(webhookDeliveries)
      .set({ claimed_by: null })
      .where(eq(webhookDeliveries.id, pendingDeliveryId));
  });

  it("never flips a delivered row (claimed_by null) to pending", async () => {
    // Double-delivery race guard: a delivered row with claimed_by=null (worker
    // finished + released the claim) must never be re-queued. The UPDATE's
    // status IN (pending, failed) guard backstops the pre-SELECT 400 so a
    // TOCTOU flip cannot re-deliver.
    const [before] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveredDeliveryId)).limit(1);
    expect(before.status).toBe("delivered");
    expect(before.claimed_by).toBeNull();

    const res = await request(app)
      .post(`/api/v1/webhooks/deliveries/${deliveredDeliveryId}/retry`)
      .set(auth());

    // Pre-SELECT returns 400; the row must remain delivered regardless.
    expect(res.status).toBe(400);
    const [after] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveredDeliveryId)).limit(1);
    expect(after.status).toBe("delivered");
  });
});

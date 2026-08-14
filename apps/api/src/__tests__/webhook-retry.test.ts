import { describe, it, expect, vi, beforeAll } from "vitest";
import { WebhookService } from "../services/webhooks";
import { WebhookRetryWorker } from "../services/webhook-retry-worker";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { webhookDeliveries, templates, reviews } from "@gatewerk/db/src/schema/index";
import { eq } from "drizzle-orm";
import { generateId } from "@gatewerk/shared";

describe("WebhookService with DB tracking", () => {
  let db: any;
  let reviewId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);

    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "wh-test-tpl",
      project_id: seed.project.id,
      name: "Webhook Test Template",
      fields: [{ name: "text", type: "text", label: "Text" }],
      actions: ["approve", "reject"],
    }).returning();

    const [rev] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: seed.project.id,
      template_id: tpl.id,
      template_slug: "wh-test-tpl",
      payload: { text: "hello" },
      callback_url: "https://example.com/cb",
    }).returning();
    reviewId = rev.id;
  });

  it("creates a delivery record and marks delivered on success", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const ws = new WebhookService({ fetch: mockFetch, db });

    await ws.sendDecision({
      chain_run_id: null,
      callback_url: "https://agent.example.com/callback",
      hmac_secret: "secret123",
      review_id: reviewId,
      decision: "approved",
      decided_at: "2026-03-09T12:00:00.000Z",
    });

    expect(mockFetch).toHaveBeenCalledOnce();

    const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.review_id, reviewId));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("delivered");
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].delivered_at).toBeTruthy();
    expect(rows[0].event_type).toBe("review.decided");
  });

  it("marks delivery as pending with error on fetch failure", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    const ws = new WebhookService({ fetch: mockFetch, db });

    await ws.sendDecision({
      chain_run_id: null,
      callback_url: "https://agent.example.com/callback",
      hmac_secret: "secret123",
      review_id: reviewId,
      decision: "rejected",
      decided_at: "2026-03-09T13:00:00.000Z",
    });

    const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.review_id, reviewId));
    const delivery = rows.find((r: any) => (r.payload as any).decision === "rejected");
    expect(delivery).toBeTruthy();
    expect(delivery.status).toBe("pending");
    expect(delivery.attempts).toBe(1);
    expect(delivery.last_error).toBe("Connection refused");
    expect(delivery.next_attempt_at).toBeTruthy();
  });

  it("marks delivery as pending on non-2xx response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }));
    const ws = new WebhookService({ fetch: mockFetch, db });

    await ws.sendRetry({
      callback_url: "https://agent.example.com/retry",
      hmac_secret: "secret123",
      review_id: reviewId,
      feedback: "Too vague",
    });

    const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.review_id, reviewId));
    const delivery = rows.find((r: any) => r.event_type === "review.retried");
    expect(delivery).toBeTruthy();
    expect(delivery.status).toBe("pending");
    expect(delivery.last_error).toContain("500");
  });

  it("still works without db (backward compat)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const ws = new WebhookService({ fetch: mockFetch });

    // Should not throw
    await ws.sendDecision({
      chain_run_id: null,
      callback_url: "https://agent.example.com/callback",
      hmac_secret: "secret123",
      review_id: "gw_rev_test",
      decision: "approved",
      decided_at: "2026-03-09T12:00:00.000Z",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

describe("WebhookRetryWorker", () => {
  let db: any;
  let reviewId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);

    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "retry-worker-tpl",
      project_id: seed.project.id,
      name: "Retry Worker Test",
      fields: [{ name: "text", type: "text", label: "Text" }],
      actions: ["approve", "reject"],
    }).returning();

    const [rev] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: seed.project.id,
      template_id: tpl.id,
      template_slug: "retry-worker-tpl",
      payload: { text: "hello" },
      callback_url: "https://example.com/cb",
    }).returning();
    reviewId = rev.id;
  });

  it("retries pending deliveries whose next_attempt_at has passed", async () => {
    const deliveryId = generateId("delivery");
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      review_id: reviewId,
      event_type: "review.decided",
      url: "https://agent.example.com/callback",
      payload: { type: "review.decided", review_id: reviewId, decision: "approved" },
      status: "pending",
      attempts: 1,
      max_attempts: 5,
      next_attempt_at: new Date(Date.now() - 10000),
      last_error: "Connection refused",
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const webhooks = new WebhookService({ fetch: mockFetch, db });
    const worker = new WebhookRetryWorker({ db, webhooks });

    const processed = await worker.processRetries();
    expect(processed).toBe(1);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [updated] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
    expect(updated.status).toBe("delivered");
  });

  it("marks delivery as failed after max attempts", async () => {
    const deliveryId = generateId("delivery");
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      review_id: reviewId,
      event_type: "review.decided",
      url: "https://agent.example.com/callback",
      payload: { type: "review.decided", review_id: reviewId, decision: "rejected" },
      status: "pending",
      attempts: 5,
      max_attempts: 5,
      next_attempt_at: new Date(Date.now() - 10000),
      last_error: "Connection refused",
    });

    const mockFetch = vi.fn().mockRejectedValue(new Error("Still down"));
    const webhooks = new WebhookService({ fetch: mockFetch, db });
    const worker = new WebhookRetryWorker({ db, webhooks });

    const processed = await worker.processRetries();
    expect(processed).toBe(1);

    const [updated] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
    expect(updated.status).toBe("failed");
  });

  it("skips deliveries whose next_attempt_at is in the future", async () => {
    const deliveryId = generateId("delivery");
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      review_id: reviewId,
      event_type: "review.decided",
      url: "https://agent.example.com/callback",
      payload: { type: "review.decided", review_id: reviewId, decision: "approved" },
      status: "pending",
      attempts: 1,
      max_attempts: 5,
      next_attempt_at: new Date(Date.now() + 60000), // 1 minute in the future
      last_error: "Connection refused",
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const webhooks = new WebhookService({ fetch: mockFetch, db });
    const worker = new WebhookRetryWorker({ db, webhooks });

    const processed = await worker.processRetries();
    // Should not pick up the future delivery (though others from previous tests may exist)
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

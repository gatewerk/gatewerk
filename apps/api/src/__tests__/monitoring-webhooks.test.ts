import { describe, it, expect, vi, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { WebhookService } from "../services/webhooks";
import { EventBus } from "../services/events";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { webhookDeliveries, templates, reviews } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
}

describe("monitoring webhook senders", () => {
  it("sendVetoed posts type review.vetoed with vetoed_by and optional note", async () => {
    const fetchFn = okFetch();
    const wh = new WebhookService({ fetch: fetchFn as any });
    await wh.sendVetoed({
      callback_url: "https://agent.example/cb",
      hmac_secret: "s",
      review_id: "review_1",
      vetoed_at: "2026-07-02T12:00:00.000Z",
      vetoed_by: "alice@example.com",
      note: "wrong channel",
    });
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body).toEqual({
      type: "review.vetoed",
      review_id: "review_1",
      vetoed_at: "2026-07-02T12:00:00.000Z",
      vetoed_by: "alice@example.com",
      note: "wrong channel",
    });
    expect(fetchFn.mock.calls[0][1].headers["X-Webhook-Event"]).toBe("review.vetoed");
  });

  it("sendVetoed omits note key when not provided", async () => {
    const fetchFn = okFetch();
    const wh = new WebhookService({ fetch: fetchFn as any });
    await wh.sendVetoed({ callback_url: "https://a.example/cb", hmac_secret: "s", review_id: "r1", vetoed_at: "t", vetoed_by: "u" });
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect("note" in body).toBe(false);
  });

  it("sendConfirmed posts type review.confirmed with mandatory lapsed flag", async () => {
    const fetchFn = okFetch();
    const wh = new WebhookService({ fetch: fetchFn as any });
    await wh.sendConfirmed({
      callback_url: "https://agent.example/cb",
      hmac_secret: "s",
      review_id: "review_1",
      confirmed_at: "2026-07-02T12:05:00.000Z",
      decided_by: "system:monitoring_window",
      lapsed: true,
    });
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body).toEqual({
      type: "review.confirmed",
      review_id: "review_1",
      confirmed_at: "2026-07-02T12:05:00.000Z",
      decided_by: "system:monitoring_window",
      lapsed: true,
    });
  });

  it("sendConfirmed carries lapsed:false for human confirms (falsy value must not be dropped)", async () => {
    const fetchFn = okFetch();
    const wh = new WebhookService({ fetch: fetchFn as any });
    await wh.sendConfirmed({ callback_url: "https://a.example/cb", hmac_secret: "s", review_id: "r1", confirmed_at: "t", decided_by: "alice@example.com", lapsed: false });
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.lapsed).toBe(false);
  });

  it("never routes the new decisions through review.decided", async () => {
    const fetchFn = okFetch();
    const wh = new WebhookService({ fetch: fetchFn as any });
    await wh.sendVetoed({ callback_url: "https://a.example/cb", hmac_secret: "s", review_id: "r", vetoed_at: "t", vetoed_by: "u" });
    expect(fetchFn.mock.calls[0][1].headers["X-Webhook-Event"]).not.toBe("review.decided");
  });
});

describe("monitoring webhook veto-delivery-failure signal", () => {
  let db: any;
  let reviewId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);

    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "mon-wh-tpl",
      project_id: seed.project.id,
      name: "Monitoring Webhook Test Template",
      fields: [{ name: "text", type: "text", label: "Text" }],
      actions: ["approve", "reject"],
    }).returning();

    const [rev] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: seed.project.id,
      template_id: tpl.id,
      template_slug: "mon-wh-tpl",
      payload: { text: "hello" },
      callback_url: "https://example.com/cb",
    }).returning();
    reviewId = rev.id;
  });

  it("emits review.veto_delivery_failed when a review.vetoed delivery exhausts retries", async () => {
    const alwaysFailingFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    const eventBus = new EventBus();
    const captured: Array<{ review_id: string; delivery_id: string; failed_at: string }> = [];
    eventBus.on("review.veto_delivery_failed", (data) => {
      captured.push({
        review_id: data.review_id,
        delivery_id: data.delivery_id!,
        failed_at: data.failed_at!,
      });
    });

    const wh = new WebhookService({ db, fetch: alwaysFailingFetch as any, eventBus });

    // Seed a delivery at max_attempts - 1 so the next failure is terminal.
    const deliveryId = generateId("delivery");
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      review_id: reviewId,
      event_type: "review.vetoed",
      url: "https://agent.example/cb",
      payload: { type: "review.vetoed", review_id: reviewId },
      status: "pending",
      attempts: 4,
      max_attempts: 5,
      next_attempt_at: new Date(Date.now() - 10_000),
      last_error: "Connection refused",
    });

    // retryDelivery increments attempts → 5, deliver fails, handleFailure marks terminal.
    await wh.retryDelivery({
      id: deliveryId,
      url: "https://agent.example/cb",
      payload: { type: "review.vetoed", review_id: reviewId },
      hmac_secret: "s",
      event_type: "review.vetoed",
      attempts: 4,
      max_attempts: 5,
    });

    // Delivery row should be marked failed.
    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
    expect(row.status).toBe("failed");

    // Bus should have received the signal.
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const signal = captured.find((c) => c.review_id === reviewId);
    expect(signal).toBeDefined();
    expect(signal?.delivery_id).toBe(deliveryId);
    expect(signal?.failed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601 prefix
  });

  it("does NOT emit veto_delivery_failed for other event types that fail terminally", async () => {
    const alwaysFailingFetch = vi.fn().mockRejectedValue(new Error("Down"));
    const eventBus = new EventBus();
    const emitSpy = vi.spyOn(eventBus, "emit");

    const wh = new WebhookService({ db, fetch: alwaysFailingFetch as any, eventBus });

    const deliveryId2 = generateId("delivery");
    await db.insert(webhookDeliveries).values({
      id: deliveryId2,
      review_id: reviewId,
      event_type: "review.confirmed",
      url: "https://agent.example/cb",
      payload: { type: "review.confirmed", review_id: reviewId },
      status: "pending",
      attempts: 4,
      max_attempts: 5,
      next_attempt_at: new Date(Date.now() - 10_000),
      last_error: "Down",
    });

    await wh.retryDelivery({
      id: deliveryId2,
      url: "https://agent.example/cb",
      payload: { type: "review.confirmed", review_id: reviewId },
      hmac_secret: "s",
      event_type: "review.confirmed",
      attempts: 4,
      max_attempts: 5,
    });

    // Should NOT have emitted veto_delivery_failed.
    const vetoFailedCalls = emitSpy.mock.calls.filter(
      ([event]) => event === "review.veto_delivery_failed",
    );
    expect(vetoFailedCalls.length).toBe(0);
  });

  it("does NOT emit confirmed_delivery_failed for other event types that fail terminally", async () => {
    const alwaysFailingFetch = vi.fn().mockRejectedValue(new Error("Down"));
    const eventBus = new EventBus();
    const emitSpy = vi.spyOn(eventBus, "emit");

    const wh = new WebhookService({ db, fetch: alwaysFailingFetch as any, eventBus });

    const deliveryId4 = generateId("delivery");
    await db.insert(webhookDeliveries).values({
      id: deliveryId4,
      review_id: reviewId,
      event_type: "review.decided",
      url: "https://agent.example/cb",
      payload: { type: "review.decided", review_id: reviewId },
      status: "pending",
      attempts: 4,
      max_attempts: 5,
      next_attempt_at: new Date(Date.now() - 10_000),
      last_error: "Down",
    });

    await wh.retryDelivery({
      id: deliveryId4,
      url: "https://agent.example/cb",
      payload: { type: "review.decided", review_id: reviewId },
      hmac_secret: "s",
      event_type: "review.decided",
      attempts: 4,
      max_attempts: 5,
    });

    // Delivery row should still be marked failed.
    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId4));
    expect(row.status).toBe("failed");

    // Should NOT have emitted confirmed_delivery_failed.
    const confirmedFailedCalls = emitSpy.mock.calls.filter(
      ([event]) => event === "review.confirmed_delivery_failed",
    );
    expect(confirmedFailedCalls.length).toBe(0);
  });

  it("still marks the delivery failed when the review-context SELECT throws (emit path is isolated)", async () => {
    const alwaysFailingFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    const eventBus = new EventBus();
    const emitSpy = vi.spyOn(eventBus, "emit");

    // handleFailure's delivery lookup calls db.select() with NO args; the
    // review-context lookup calls db.select({ fields }). Throw only on the
    // latter to simulate a transient DB error scoped to the emit path.
    const throwingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") {
          return (...args: unknown[]) => {
            if (args.length > 0) throw new Error("transient DB hiccup");
            return target.select();
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const wh = new WebhookService({ db: throwingDb, fetch: alwaysFailingFetch as any, eventBus });

    const deliveryId3 = generateId("delivery");
    await db.insert(webhookDeliveries).values({
      id: deliveryId3,
      review_id: reviewId,
      event_type: "review.vetoed",
      url: "https://agent.example/cb",
      payload: { type: "review.vetoed", review_id: reviewId },
      status: "pending",
      attempts: 4,
      max_attempts: 5,
      next_attempt_at: new Date(Date.now() - 10_000),
      last_error: "Connection refused",
    });

    // Must not throw despite the context SELECT failing.
    await expect(wh.retryDelivery({
      id: deliveryId3,
      url: "https://agent.example/cb",
      payload: { type: "review.vetoed", review_id: reviewId },
      hmac_secret: "s",
      event_type: "review.vetoed",
      attempts: 4,
      max_attempts: 5,
    })).resolves.toBeUndefined();

    // Delivery row still terminal with the ORIGINAL delivery error, not the DB error.
    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId3));
    expect(row.status).toBe("failed");
    expect(row.last_error).toBe("Connection refused");

    // Emit was skipped (swallowed + logged), not propagated.
    const vetoFailedCalls = emitSpy.mock.calls.filter(
      ([event]) => event === "review.veto_delivery_failed",
    );
    expect(vetoFailedCalls.length).toBe(0);
  });
});

describe("monitoring webhook confirmed-delivery-failure signal", () => {
  let db: any;
  let reviewId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);

    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "mon-wh-confirmed-tpl",
      project_id: seed.project.id,
      name: "Monitoring Webhook Confirmed Test Template",
      fields: [{ name: "text", type: "text", label: "Text" }],
      actions: ["approve", "reject"],
    }).returning();

    const [rev] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: seed.project.id,
      template_id: tpl.id,
      template_slug: "mon-wh-confirmed-tpl",
      payload: { text: "hello" },
      callback_url: "https://example.com/cb",
    }).returning();
    reviewId = rev.id;
  });

  it("emits review.confirmed_delivery_failed when a review.confirmed delivery exhausts retries", async () => {
    const alwaysFailingFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    const eventBus = new EventBus();
    const captured: Array<{ review_id: string; delivery_id: string; failed_at: string }> = [];
    eventBus.on("review.confirmed_delivery_failed", (data) => {
      captured.push({
        review_id: data.review_id,
        delivery_id: data.delivery_id!,
        failed_at: data.failed_at!,
      });
    });

    const wh = new WebhookService({ db, fetch: alwaysFailingFetch as any, eventBus });

    // Seed a delivery at max_attempts - 1 so the next failure is terminal.
    const deliveryId = generateId("delivery");
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      review_id: reviewId,
      event_type: "review.confirmed",
      url: "https://agent.example/cb",
      payload: { type: "review.confirmed", review_id: reviewId },
      status: "pending",
      attempts: 4,
      max_attempts: 5,
      next_attempt_at: new Date(Date.now() - 10_000),
      last_error: "Connection refused",
    });

    // retryDelivery increments attempts → 5, deliver fails, handleFailure marks terminal.
    await wh.retryDelivery({
      id: deliveryId,
      url: "https://agent.example/cb",
      payload: { type: "review.confirmed", review_id: reviewId },
      hmac_secret: "s",
      event_type: "review.confirmed",
      attempts: 4,
      max_attempts: 5,
    });

    // Delivery row should be marked failed.
    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
    expect(row.status).toBe("failed");

    // Bus should have received the signal.
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const signal = captured.find((c) => c.review_id === reviewId);
    expect(signal).toBeDefined();
    expect(signal?.delivery_id).toBe(deliveryId);
    expect(signal?.failed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601 prefix
  });
});

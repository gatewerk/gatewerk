import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, reviews } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { TimeoutWorker } from "../services/timeout-worker";
import { WebhookService } from "../services/webhooks";
import { EventBus } from "../services/events";
import { eq } from "drizzle-orm";

describe("TimeoutWorker.processExpiredChangeRequests", () => {
  let db: any, projectId: string;

  beforeAll(async () => {
    const { db: testDb } = await createTestDb();
    db = testDb;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "ct-test",
      project_id: projectId,
      name: "Changes Timeout Test",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      changes_timeout_hours: 1,
    });
    // Template with no timeout — stale reviews against it must be left alone
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "ct-no-timeout",
      project_id: projectId,
      name: "No Timeout Test",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      changes_timeout_hours: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeWorker(eventBus?: EventBus) {
    return new TimeoutWorker({ db, webhooks: new WebhookService({ db }), eventBus: eventBus ?? new EventBus() });
  }

  it("reverts a stale awaiting_iteration review to pending", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_slug: "ct-test",
      payload: { content: "stale" },
      status: "awaiting_iteration",
      updated_at: new Date(Date.now() - 2 * 3600_000),
    });
    const reverted = await makeWorker().processExpiredChangeRequests();
    expect(reverted).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.status).toBe("pending");
  });

  it("leaves fresh awaiting_iteration reviews alone", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_slug: "ct-test",
      payload: { content: "fresh" },
      status: "awaiting_iteration",
      updated_at: new Date(),
    });
    await makeWorker().processExpiredChangeRequests();
    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.status).toBe("awaiting_iteration");
  });

  it("leaves stale reviews alone when template has changes_timeout_hours NULL", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_slug: "ct-no-timeout",
      payload: { content: "stale but no timeout" },
      status: "awaiting_iteration",
      updated_at: new Date(Date.now() - 48 * 3600_000),
    });
    await makeWorker().processExpiredChangeRequests();
    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.status).toBe("awaiting_iteration");
  });

  it("leaves stale decided reviews alone", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_slug: "ct-test",
      payload: { content: "decided" },
      status: "decided",
      decision: "approved",
      decided_by: "reviewer@example.com",
      decided_at: new Date(Date.now() - 3 * 3600_000),
      updated_at: new Date(Date.now() - 3 * 3600_000),
    });
    await makeWorker().processExpiredChangeRequests();
    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.status).toBe("decided");
  });

  it("emits review.retried on the eventBus for each reverted review", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_slug: "ct-test",
      payload: { content: "emit-check" },
      status: "awaiting_iteration",
      updated_at: new Date(Date.now() - 2 * 3600_000),
    });
    const eventBus = new EventBus();
    const emitSpy = vi.spyOn(eventBus, "emit");
    await makeWorker(eventBus).processExpiredChangeRequests();
    expect(emitSpy).toHaveBeenCalledWith("review.retried", expect.objectContaining({
      review_id: reviewId,
    }));
  });
});

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, reviews } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { TimeoutWorker } from "../services/timeout-worker";
import { WebhookService } from "../services/webhooks";
import { EventBus } from "../services/events";
import { eq } from "drizzle-orm";

describe("TimeoutWorker.processMaxIterations", () => {
  let db: any;
  let projectId: string;
  let templateId: string;

  beforeAll(async () => {
    const { db: testDb } = await createTestDb();
    db = testDb;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;

    templateId = generateId("template");
    await db.insert(templates).values({
      id: templateId,
      slug: "max-iter-test",
      project_id: projectId,
      name: "Max Iterations Test",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes an awaiting_iteration review when current_version - 1 >= max_iterations", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "max-iter-test",
      payload: { content: "stuck" },
      callback_url: "https://example.com/webhook",
      status: "awaiting_iteration",
      current_version: 4, // iteration_count = 3 (current_version - 1)
      max_iterations: 3,
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch });
    const eventBus = new EventBus();
    const emitSpy = vi.spyOn(eventBus, "emit");

    const worker = new TimeoutWorker({ db, webhooks, eventBus });
    const count = await worker.processMaxIterations();

    expect(count).toBe(1);

    const [updated] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    expect(updated.status).toBe("decided");
    expect(updated.decision).toBe("max_iterations_reached");
    expect(updated.decided_by).toBe("system:max_iterations");
    // Webhook was fired
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.decision).toBe("max_iterations_reached");
    expect(body.iteration_count).toBe(3);
    // EventBus emitted review.decided
    expect(emitSpy).toHaveBeenCalledWith("review.decided", expect.objectContaining({
      review_id: reviewId,
      decision: "max_iterations_reached",
    }));
  });

  it("does not close an awaiting_iteration review below the cap", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "max-iter-test",
      payload: { content: "still going" },
      status: "awaiting_iteration",
      current_version: 3, // iteration_count = 2, cap = 3
      max_iterations: 3,
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch });
    const eventBus = new EventBus();

    const worker = new TimeoutWorker({ db, webhooks, eventBus });
    const count = await worker.processMaxIterations();

    // This review should NOT be included (2 < 3)
    const [updated] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    expect(updated.status).toBe("awaiting_iteration");
    expect(updated.decision).toBeNull();
  });

  it("does not touch a pending review even when current_version - 1 >= max_iterations", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "max-iter-test",
      payload: { content: "pending" },
      status: "pending",
      current_version: 5,
      max_iterations: 2,
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch });
    const eventBus = new EventBus();

    const worker = new TimeoutWorker({ db, webhooks, eventBus });
    await worker.processMaxIterations();

    const [updated] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    expect(updated.status).toBe("pending");
  });

  it("skips callback when callback_url is null", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "max-iter-test",
      payload: { content: "no callback" },
      callback_url: null,
      status: "awaiting_iteration",
      current_version: 4,
      max_iterations: 3,
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch });
    const eventBus = new EventBus();

    const worker = new TimeoutWorker({ db, webhooks, eventBus });
    const count = await worker.processMaxIterations();

    expect(count).toBeGreaterThanOrEqual(1);
    // No HTTP call since callback_url is null
    expect(mockFetch).not.toHaveBeenCalled();

    const [updated] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId));
    expect(updated.status).toBe("decided");
    expect(updated.decision).toBe("max_iterations_reached");
  });

  it("processMaxIterations is called from tick() and included in the result", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "max-iter-test",
      payload: { content: "tick test" },
      status: "awaiting_iteration",
      current_version: 6,
      max_iterations: 2,
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch });
    const eventBus = new EventBus();

    const worker = new TimeoutWorker({ db, webhooks, eventBus });
    const result = await worker.tick();

    // tick() returns { expired, promoted, reclaimed, maxIterations }
    expect(result).toHaveProperty("maxIterations");
    expect(result.maxIterations).toBeGreaterThanOrEqual(1);
  });

  it("does not clobber a review re-submitted concurrently between claim and close", async () => {
    // Race: the worker claims a review at v4/awaiting_iteration (cap 3), then —
    // before the terminal write — the agent's iteration-submit path commits a
    // new version (status→pending, current_version→5). The atomic WHERE on the
    // close re-checks live state, so the stale snapshot yields 0 rows: the
    // committed v5 is preserved, no max_iterations_reached, no stale webhook.
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "max-iter-test",
      payload: { content: "race" },
      callback_url: "https://example.com/webhook",
      status: "awaiting_iteration",
      current_version: 4, // iteration_count = 3, at cap
      max_iterations: 3,
    });

    // The snapshot the worker captured at claim time (still awaiting_iteration,
    // v4). closeMaxIterations is invoked with THIS snapshot.
    const [claimedSnapshot] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    // Concurrent submit commits between claim and close: status→pending, v5.
    await db
      .update(reviews)
      .set({ status: "pending", current_version: 5 })
      .where(eq(reviews.id, reviewId));

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch });
    const eventBus = new EventBus();
    const emitSpy = vi.spyOn(eventBus, "emit");

    const worker = new TimeoutWorker({ db, webhooks, eventBus });
    // Drive the close path directly with the stale snapshot.
    await (worker as any).closeMaxIterations(claimedSnapshot);

    const [after] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    // NOT clobbered: the concurrently-committed v5 / pending survives.
    expect(after.status).toBe("pending");
    expect(after.current_version).toBe(5);
    expect(after.decision).toBeNull();
    // No stale webhook fired, no stale event emitted.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalledWith("review.decided", expect.anything());
  });
});

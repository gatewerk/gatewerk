import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedTestProject } from "../__tests__/helpers/test-db";
import { reviews, templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { TimeoutWorker } from "./timeout-worker";
import { WebhookService } from "./webhooks";
import { EventBus } from "./events";

/**
 * Integration tests for TimeoutWorker.processReminders().
 *
 * The reminder sweep fires once per review at 75% of its timeout window:
 *   created_at + (expires_at - created_at) * 0.75 <= NOW()
 *   AND expires_at > NOW()                   (not yet expired)
 *   AND reminder_sent_at IS NULL             (idempotency guard)
 *   AND status IN ('pending','awaiting_external')
 *
 * Uses PGlite with explicit created_at/expires_at seeds to control timing
 * without fake timers. Each test inserts its own review to avoid cross-test
 * interference.
 */

describe("TimeoutWorker.processReminders()", () => {
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
      slug: "reminder-test",
      project_id: projectId,
      name: "Reminder Test",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeWorker() {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch });
    const eventBus = new EventBus();
    const emitSpy = vi.spyOn(eventBus, "emit");
    const worker = new TimeoutWorker({ db, webhooks, eventBus });
    return { worker, eventBus, emitSpy };
  }

  it("(a) reminds one review past 75% elapsed and sets reminder_sent_at", async () => {
    // Window: 110 minutes (created 90m ago, expires 20m from now).
    // 75% = 82.5m elapsed threshold. 90m elapsed > 82.5m → should remind.
    const reviewId = generateId("review");
    const createdAt = new Date(Date.now() - 90 * 60 * 1000);   // 90 minutes ago
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000);   // 20 minutes from now

    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "reminder-test",
      payload: { content: "remind me" },
      status: "pending",
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: expiresAt,
    });

    const { worker, emitSpy } = makeWorker();
    const count = await worker.processReminders();

    expect(count).toBe(1);

    const [updated] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(updated.reminder_sent_at).not.toBeNull();

    expect(emitSpy).toHaveBeenCalledWith(
      "review.reminder",
      expect.objectContaining({ review_id: reviewId }),
    );
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it("(b) second processReminders() call returns 0 — idempotency via reminder_sent_at", async () => {
    // Same 75%-elapsed window as (a), different review ID.
    const reviewId = generateId("review");
    const createdAt = new Date(Date.now() - 90 * 60 * 1000);
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000);

    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "reminder-test",
      payload: { content: "idempotency check" },
      status: "pending",
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: expiresAt,
    });

    const { worker, emitSpy } = makeWorker();

    const first = await worker.processReminders();
    expect(first).toBe(1);
    expect(emitSpy).toHaveBeenCalledTimes(1);

    // Reset spy count but keep tracking calls
    emitSpy.mockClear();

    const second = await worker.processReminders();
    expect(second).toBe(0);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("(c) review not yet at 75% elapsed is not reminded", async () => {
    // Window: 120 minutes (created 10m ago, expires 110m from now).
    // 75% = 90m elapsed threshold. 10m elapsed < 90m → NOT reminded.
    const reviewId = generateId("review");
    const createdAt = new Date(Date.now() - 10 * 60 * 1000);    // 10 minutes ago
    const expiresAt = new Date(Date.now() + 110 * 60 * 1000);   // 110 minutes from now

    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "reminder-test",
      payload: { content: "not yet" },
      status: "pending",
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: expiresAt,
    });

    const { worker, emitSpy } = makeWorker();
    const count = await worker.processReminders();

    // This worker only sees this test's review (others already reminded).
    // count may be 0 for THIS review specifically.
    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.reminder_sent_at).toBeNull();

    // The emit should not have been called for this review_id.
    const calledForThisReview = emitSpy.mock.calls.some(
      ([, data]) => data.review_id === reviewId,
    );
    expect(calledForThisReview).toBe(false);
  });

  it("(d) terminal/decided review is not reminded", async () => {
    // A decided review must be excluded even if it was past the 75% mark.
    const reviewId = generateId("review");
    const createdAt = new Date(Date.now() - 90 * 60 * 1000);
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000);

    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "reminder-test",
      payload: { content: "already decided" },
      status: "decided",
      decision: "approved",
      decided_by: "alice",
      decided_at: new Date(),
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: expiresAt,
    });

    const { worker, emitSpy } = makeWorker();
    await worker.processReminders();

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.reminder_sent_at).toBeNull();

    const calledForThisReview = emitSpy.mock.calls.some(
      ([, data]) => data.review_id === reviewId,
    );
    expect(calledForThisReview).toBe(false);
  });

  it("(d2) archived/expired review is not reminded", async () => {
    const reviewId = generateId("review");
    const createdAt = new Date(Date.now() - 90 * 60 * 1000);
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000);

    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "reminder-test",
      payload: { content: "archived" },
      status: "archived",
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: expiresAt,
    });

    const { worker, emitSpy } = makeWorker();
    await worker.processReminders();

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.reminder_sent_at).toBeNull();

    const calledForThisReview = emitSpy.mock.calls.some(
      ([, data]) => data.review_id === reviewId,
    );
    expect(calledForThisReview).toBe(false);
  });

  it("(e) awaiting_external review past 75% is also reminded", async () => {
    const reviewId = generateId("review");
    const createdAt = new Date(Date.now() - 90 * 60 * 1000);
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000);

    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "reminder-test",
      payload: { content: "external" },
      status: "awaiting_external",
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: expiresAt,
    });

    const { worker, emitSpy } = makeWorker();
    await worker.processReminders();

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.reminder_sent_at).not.toBeNull();

    const calledForThisReview = emitSpy.mock.calls.some(
      ([, data]) => data.review_id === reviewId,
    );
    expect(calledForThisReview).toBe(true);
  });
});

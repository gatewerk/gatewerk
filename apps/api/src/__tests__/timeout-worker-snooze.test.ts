import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviews, templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import type { AssignmentLadder } from "@gatewerk/shared";
import { TimeoutWorker } from "../services/timeout-worker";
import { WebhookService } from "../services/webhooks";
import { EventBus } from "../services/events";

// Integration tests: snooze pauses BOTH the expiry path AND the
// ladder-promotion path of TimeoutWorker.  PGlite, no fake timers.

const aliceManager: AssignmentLadder = [
  { actor: "alice", trigger_after_seconds: 60, status: "active" },
  { actor: "manager", trigger_after_seconds: 7200, status: "pending" },
];

describe("TimeoutWorker — snooze guard", () => {
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
      slug: "snooze-test",
      project_id: projectId,
      name: "Snooze Test",
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
    return new TimeoutWorker({ db, webhooks, eventBus });
  }

  // ── Expiry path ───────────────────────────────────────────────────────────

  it("1. does NOT expire a review whose snoozed_until is in the future", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "snooze-test",
      payload: { content: "snoozed" },
      status: "pending",
      timeout_action: "expire",
      timeout_seconds: 60,
      // expires_at is in the PAST — would normally trigger expiry
      expires_at: new Date(Date.now() - 1_000),
      // but snooze is in the FUTURE — must block the worker
      snoozed_until: new Date(Date.now() + 60_000),
    });

    const worker = makeWorker();
    const expired = await worker.processExpired();
    expect(expired).toBe(0);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.status).toBe("pending");
  });

  it("2. DOES expire a review whose snoozed_until has already elapsed", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "snooze-test",
      payload: { content: "snooze elapsed" },
      status: "pending",
      timeout_action: "expire",
      timeout_seconds: 60,
      expires_at: new Date(Date.now() - 1_000),
      // snooze has already elapsed — worker must process it normally
      snoozed_until: new Date(Date.now() - 5_000),
    });

    const worker = makeWorker();
    const expired = await worker.processExpired();
    expect(expired).toBe(1);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.status).toBe("expired");
  });

  // ── Ladder-promotion path ─────────────────────────────────────────────────

  it("3. does NOT ladder-promote a review whose snoozed_until is in the future", async () => {
    const reviewId = generateId("review");
    const createdAt = new Date(Date.now() - 10_000);
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "snooze-test",
      payload: { content: "ladder snoozed" },
      assignee: "alice",
      status: "pending",
      assignment_ladder: aliceManager,
      ladder_index: 0,
      // ladder_next_promote_at in the PAST — would normally promote
      ladder_next_promote_at: new Date(Date.now() - 1_000),
      expires_at: null,
      // but snooze is in the FUTURE — must block the worker
      snoozed_until: new Date(Date.now() + 60_000),
      created_at: createdAt,
      updated_at: createdAt,
    });

    const worker = makeWorker();
    const promoted = await worker.processLadderPromotions();
    expect(promoted).toBe(0);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.ladder_index).toBe(0);
    expect(row.assignee).toBe("alice");
  });

  it("4. DOES ladder-promote a review whose snoozed_until has already elapsed", async () => {
    const reviewId = generateId("review");
    const createdAt = new Date(Date.now() - 10_000);
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "snooze-test",
      payload: { content: "ladder snooze elapsed" },
      assignee: "alice",
      status: "pending",
      assignment_ladder: aliceManager,
      ladder_index: 0,
      ladder_next_promote_at: new Date(Date.now() - 1_000),
      expires_at: null,
      // snooze elapsed — worker must promote normally
      snoozed_until: new Date(Date.now() - 5_000),
      created_at: createdAt,
      updated_at: createdAt,
    });

    const worker = makeWorker();
    const promoted = await worker.processLadderPromotions();
    expect(promoted).toBe(1);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.ladder_index).toBe(1);
    expect(row.assignee).toBe("manager");
  });

  // ── held_by must NOT block the worker ─────────────────────────────────────

  it("5. DOES expire a review with held_by set but snoozed_until null (hold ≠ snooze)", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "snooze-test",
      payload: { content: "held but not snoozed" },
      status: "pending",
      timeout_action: "expire",
      timeout_seconds: 60,
      expires_at: new Date(Date.now() - 1_000),
      // Human soft-lock is set — must NOT prevent expiry
      held_by: "user-abc",
      held_at: new Date(Date.now() - 30_000),
      snoozed_until: null,
    });

    const worker = makeWorker();
    const expired = await worker.processExpired();
    expect(expired).toBe(1);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.status).toBe("expired");
  });

  // ── Baseline: snoozed_until null follows normal path ─────────────────────

  it("6. a review with snoozed_until=null follows the normal expiry path (baseline)", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "snooze-test",
      payload: { content: "no snooze" },
      status: "pending",
      timeout_action: "expire",
      timeout_seconds: 60,
      expires_at: new Date(Date.now() - 1_000),
      snoozed_until: null,
    });

    const worker = makeWorker();
    const expired = await worker.processExpired();
    expect(expired).toBe(1);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.status).toBe("expired");
  });
});

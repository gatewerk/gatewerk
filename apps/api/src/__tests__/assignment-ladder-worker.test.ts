import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviews, templates, auditLog } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import type { AssignmentLadder } from "@gatewerk/shared";
import { TimeoutWorker } from "../services/timeout-worker";
import { WebhookService } from "../services/webhooks";
import { EventBus } from "../services/events";
import { createAuditService } from "../services/audit";

// Integration tests for the ladder-promotion path of TimeoutWorker.
// PGlite, no fake timers — we set `ladder_next_promote_at` to a past
// timestamp to trigger the claim query.

const aliceManager: AssignmentLadder = [
  { actor: "alice", trigger_after_seconds: 60, status: "active" },
  { actor: "manager", trigger_after_seconds: 7200, status: "pending" },
];

const aliceManagerAdmin: AssignmentLadder = [
  { actor: "alice", trigger_after_seconds: 60, status: "active" },
  { actor: "manager", trigger_after_seconds: 7200, status: "pending" },
  { actor: "admin", trigger_after_seconds: 14400, status: "pending" },
];

describe("TimeoutWorker — ladder promotion", () => {
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
      slug: "ladder-test",
      project_id: projectId,
      name: "Ladder Test",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function insertLadderReview(overrides: Partial<{
    ladder: AssignmentLadder;
    ladder_index: number;
    ladder_next_promote_at: Date | null;
    assignee: string;
    status: string;
    expires_at: Date | null;
    callback_url: string | null;
  }> = {}) {
    const reviewId = generateId("review");
    const now = new Date();
    const createdAt = new Date(now.getTime() - 10_000);
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "ladder-test",
      payload: { content: "ladder" },
      callback_url: overrides.callback_url === undefined ? "https://example.com/cb" : overrides.callback_url,
      assignee: overrides.assignee ?? "alice",
      status: overrides.status ?? "pending",
      assignment_ladder: overrides.ladder ?? aliceManagerAdmin,
      ladder_index: overrides.ladder_index ?? 0,
      ladder_next_promote_at: overrides.ladder_next_promote_at ?? new Date(now.getTime() - 1000),
      expires_at: overrides.expires_at ?? null,
      created_at: createdAt,
      updated_at: createdAt,
    });
    return reviewId;
  }

  it("promotes a 3-actor ladder step 0 → step 1 and updates assignee + ladder_next_promote_at", async () => {
    const reviewId = await insertLadderReview();

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch });
    const eventBus = new EventBus();
    const worker = new TimeoutWorker({ db, webhooks, eventBus });

    const promoted = await worker.processLadderPromotions();
    expect(promoted).toBe(1);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.ladder_index).toBe(1);
    expect(row.assignee).toBe("manager");
    const ladder = row.assignment_ladder as AssignmentLadder;
    expect(ladder[0].status).toBe("promoted");
    expect(ladder[1].status).toBe("active");
    expect(ladder[2].status).toBe("pending");
    // Next promote target is the step AFTER the new active one, anchored on
    // created_at + step[2].trigger_after_seconds.
    const expected = new Date(row.created_at.getTime() + 14400 * 1000);
    expect(row.ladder_next_promote_at?.toISOString()).toBe(expected.toISOString());

    // Webhook fired once with `assignment.escalated` event type.
    expect(mockFetch).toHaveBeenCalledOnce();
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["X-Webhook-Event"]).toBe("assignment.escalated");
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      type: "assignment.escalated",
      review_id: reviewId,
      previous_assignee: "alice",
      new_assignee: "manager",
      ladder_index: 1,
    });
  });

  it("promotes to the terminal step and clears ladder_next_promote_at", async () => {
    // Start at index 1 so the next promotion lands on the final step.
    const reviewId = await insertLadderReview({
      ladder: [
        { actor: "alice", trigger_after_seconds: 60, status: "promoted" },
        { actor: "manager", trigger_after_seconds: 7200, status: "active" },
        { actor: "admin", trigger_after_seconds: 14400, status: "pending" },
      ],
      ladder_index: 1,
      assignee: "manager",
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch });
    const worker = new TimeoutWorker({ db, webhooks, eventBus: new EventBus() });

    const promoted = await worker.processLadderPromotions();
    expect(promoted).toBe(1);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.ladder_index).toBe(2);
    expect(row.assignee).toBe("admin");
    expect(row.ladder_next_promote_at).toBeNull();
  });

  it("does NOT promote reviews in terminal states (decided, expired, archived)", async () => {
    const terminals = ["decided", "expired", "archived"];
    const ids: string[] = [];
    for (const status of terminals) {
      ids.push(await insertLadderReview({ status }));
    }

    const worker = new TimeoutWorker({
      db,
      webhooks: new WebhookService({ fetch: vi.fn().mockResolvedValue(new Response("ok")) }),
      eventBus: new EventBus(),
    });
    const promoted = await worker.processLadderPromotions();
    expect(promoted).toBe(0);

    for (const id of ids) {
      const [row] = await db.select().from(reviews).where(eq(reviews.id, id));
      expect(row.ladder_index).toBe(0);
      expect(row.assignee).toBe("alice");
    }
  });

  it("does NOT promote reviews whose ladder_next_promote_at is in the future", async () => {
    const future = new Date(Date.now() + 60_000);
    await insertLadderReview({ ladder_next_promote_at: future });

    const worker = new TimeoutWorker({
      db,
      webhooks: new WebhookService({ fetch: vi.fn().mockResolvedValue(new Response("ok")) }),
      eventBus: new EventBus(),
    });
    const promoted = await worker.processLadderPromotions();
    expect(promoted).toBe(0);
  });

  it("records a review.assignment_escalated audit entry with actor=system:ladder", async () => {
    const reviewId = await insertLadderReview({ ladder: aliceManager });

    const auditService = createAuditService(db);
    const worker = new TimeoutWorker({
      db,
      webhooks: new WebhookService({ fetch: vi.fn().mockResolvedValue(new Response("ok")) }),
      eventBus: new EventBus(),
      auditService,
    });
    await worker.processLadderPromotions();

    const entries = await db.select().from(auditLog).where(eq(auditLog.resource_id, reviewId));
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("review.assignment_escalated");
    expect(entries[0].actor).toBe("system:ladder");
    expect(entries[0].details).toMatchObject({
      previous_assignee: "alice",
      new_assignee: "manager",
      ladder_index: 1,
    });
  });

  it("tick() — expiry wins when a review is due for both expiry and ladder promotion", async () => {
    const now = new Date();
    const reviewId = await insertLadderReview({
      // Both timers elapsed — the expected outcome is expiry.
      expires_at: new Date(now.getTime() - 500),
      ladder_next_promote_at: new Date(now.getTime() - 500),
      callback_url: "https://example.com/cb",
    });
    // Mark it with a timeout_action so expiry has an outcome to write.
    await db
      .update(reviews)
      .set({ timeout_action: "expire" })
      .where(eq(reviews.id, reviewId));

    const worker = new TimeoutWorker({
      db,
      webhooks: new WebhookService({ fetch: vi.fn().mockResolvedValue(new Response("ok")) }),
      eventBus: new EventBus(),
    });

    const result = await worker.tick();
    expect(result.expired).toBe(1);
    expect(result.promoted).toBe(0);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.status).toBe("expired");
    // Ladder columns untouched — expiry doesn't promote.
    expect(row.ladder_index).toBe(0);
    expect(row.assignee).toBe("alice");
  });

  it("multi-instance claim safety: a second worker sees 0 promotions after the first wins", async () => {
    // Simulate pre-claim by another worker with a fresh claimed_at (within
    // the 5-min claim window) — our worker must skip the row entirely.
    const reviewId = await insertLadderReview();
    await db
      .update(reviews)
      .set({ claimed_by: "other-worker-xyz", claimed_at: new Date() })
      .where(eq(reviews.id, reviewId));

    const worker = new TimeoutWorker({
      db,
      webhooks: new WebhookService({ fetch: vi.fn().mockResolvedValue(new Response("ok")) }),
      eventBus: new EventBus(),
    });
    const promoted = await worker.processLadderPromotions();
    expect(promoted).toBe(0);

    // Row state unchanged at ladder_index=0, because the other worker's
    // claim is still fresh.
    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.ladder_index).toBe(0);
    expect(row.assignee).toBe("alice");
  });

  it("skips the webhook (but still promotes) when review has no callback_url", async () => {
    const reviewId = await insertLadderReview({ callback_url: null, ladder: aliceManager });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const worker = new TimeoutWorker({
      db,
      webhooks: new WebhookService({ fetch: mockFetch }),
      eventBus: new EventBus(),
    });
    const promoted = await worker.processLadderPromotions();
    expect(promoted).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();

    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row.assignee).toBe("manager");
  });
});

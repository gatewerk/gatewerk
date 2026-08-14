import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, reviews, auditLog } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { TimeoutWorker } from "../services/timeout-worker";
import { createAuditService } from "../services/audit";
import { WebhookService } from "../services/webhooks";
import { EventBus } from "../services/events";
import { eq, and } from "drizzle-orm";

describe("TimeoutWorker", () => {
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
      slug: "timeout-test",
      project_id: projectId,
      name: "Timeout Test",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("expires reviews past their expires_at with auto_reject action", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "timeout-test",
      payload: { content: "test" },
      callback_url: "https://example.com/webhook",
      status: "pending",
      timeout_action: "auto_reject",
      timeout_seconds: 60,
      expires_at: new Date(Date.now() - 1000), // already expired
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch });
    const eventBus = new EventBus();
    const emitSpy = vi.spyOn(eventBus, "emit");

    const worker = new TimeoutWorker({ db, webhooks, eventBus });
    await worker.processExpired();

    // Verify review was updated
    const [updated] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    expect(updated.status).toBe("decided");
    expect(updated.decision).toBe("rejected");
  });

  it("expires reviews with auto_approve action", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "timeout-test",
      payload: { content: "auto approve" },
      callback_url: "https://example.com/webhook",
      status: "pending",
      timeout_action: "auto_approve",
      timeout_seconds: 60,
      expires_at: new Date(Date.now() - 1000),
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch });
    const eventBus = new EventBus();

    const worker = new TimeoutWorker({ db, webhooks, eventBus });
    await worker.processExpired();

    const [updated] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    expect(updated.status).toBe("decided");
    expect(updated.decision).toBe("approved");
  });

  it("expires reviews with expire action (status=expired)", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "timeout-test",
      payload: { content: "just expire" },
      callback_url: "https://example.com/webhook",
      status: "pending",
      timeout_action: "expire",
      timeout_seconds: 60,
      expires_at: new Date(Date.now() - 1000),
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch });
    const eventBus = new EventBus();

    const worker = new TimeoutWorker({ db, webhooks, eventBus });
    await worker.processExpired();

    const [updated] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    expect(updated.status).toBe("expired");
  });

  it("does NOT expire reviews that are not yet past expires_at", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "timeout-test",
      payload: { content: "not yet" },
      callback_url: "https://example.com/webhook",
      status: "pending",
      timeout_action: "expire",
      timeout_seconds: 3600,
      expires_at: new Date(Date.now() + 60_000), // 1 minute from now
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch });
    const eventBus = new EventBus();

    const worker = new TimeoutWorker({ db, webhooks, eventBus });
    await worker.processExpired();

    const [unchanged] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    expect(unchanged.status).toBe("pending");
  });

  it("does NOT expire already-decided reviews", async () => {
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: templateId,
      template_slug: "timeout-test",
      payload: { content: "already done" },
      callback_url: "https://example.com/webhook",
      status: "decided",
      decision: "approved",
      timeout_action: "expire",
      timeout_seconds: 60,
      expires_at: new Date(Date.now() - 1000),
      decided_at: new Date(),
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch });
    const eventBus = new EventBus();

    const worker = new TimeoutWorker({ db, webhooks, eventBus });
    await worker.processExpired();

    const [unchanged] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId));

    expect(unchanged.status).toBe("decided");
    expect(unchanged.decision).toBe("approved");
  });

  // Timeout-driven outcomes are the transitions where no human was present:
  // the worker stamps a decision and approved_value and tells the agent to
  // proceed. Before this, they wrote nothing to the tamper-evident chain, so
  // an unattended approval left no proof at all. These tests fail if the
  // audit call is removed.
  describe("accountability for unattended decisions", () => {
    async function runTimeout(timeoutAction: string, payload: unknown) {
      const reviewId = generateId("review");
      await db.insert(reviews).values({
        id: reviewId,
        project_id: projectId,
        template_id: templateId,
        template_slug: "timeout-test",
        payload,
        callback_url: "https://example.com/webhook",
        status: "pending",
        timeout_action: timeoutAction,
        timeout_seconds: 60,
        expires_at: new Date(Date.now() - 1000),
      });

      const webhooks = new WebhookService({ fetch: vi.fn().mockResolvedValue(new Response("ok")) });
      const worker = new TimeoutWorker({
        db,
        webhooks,
        eventBus: new EventBus(),
        auditService: createAuditService(db),
      });
      await worker.processExpired();

      const rows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      return { reviewId, rows };
    }

    it("writes an audit row when a timeout auto-approves a review", async () => {
      const { rows } = await runTimeout("auto_approve", { content: "a1 auto approve" });
      const row = rows.find((r: any) => r.action === "review.auto_approved");
      expect(row).toBeDefined();
      expect(row.actor).toBe("system:timeout");
      expect(row.details.decision).toBe("approved");
    });

    it("writes an audit row when a timeout auto-rejects a review", async () => {
      const { rows } = await runTimeout("auto_reject", { content: "a1 auto reject" });
      const row = rows.find((r: any) => r.action === "review.auto_rejected");
      expect(row).toBeDefined();
      expect(row.actor).toBe("system:timeout");
      expect(row.details.decision).toBe("rejected");
    });

    it("writes an audit row when a review simply expires", async () => {
      const { rows } = await runTimeout("expire", { content: "a1 expire" });
      expect(rows.find((r: any) => r.action === "review.expired")).toBeDefined();
    });

    // The row must carry project_id. Without it the row lands in the shared
    // NULL "system" partition, which both excludes it from verify(projectId)
    // and exposes it to every tenant through the `project_id IS NULL` clause
    // in audit.query(). This assertion is the regression net for that leak.
    it("files the audit row in the review's own tenant partition", async () => {
      const { reviewId } = await runTimeout("auto_approve", { content: "a1 partition" });
      const scoped = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.resource_id, reviewId), eq(auditLog.project_id, projectId)));
      expect(scoped.length).toBeGreaterThan(0);
    });

    // The rows these paths write carry four details keys. Under v2 signing
    // that meant every one of them verified as `signature_mismatch`, because
    // details were signed with key-insertion-order JSON.stringify and read
    // back from JSONB with normalised key order. Canonical v3 signing fixes
    // it; this assertion is the regression net.
    it("leaves the audit chain verifiable", async () => {
      await runTimeout("auto_approve", { content: "a1 chain" });
      // verify() returns one result per row, not a single verdict.
      const results = await createAuditService(db).verify(projectId);
      expect(results.length).toBeGreaterThan(0);
      expect(results.filter((r) => !r.valid)).toEqual([]);
    });
  });
});

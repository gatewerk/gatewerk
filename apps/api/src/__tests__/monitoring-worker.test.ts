// HOTL monitoring gate — TimeoutWorker auto-confirm branch.
// Verifies: lapsed-window auto-confirm, in-window skip, race-safety (veto wins),
// existing passes never grab monitoring rows, and tick() confirmed count.

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import {
  templates,
  reviews as reviewsTable,
  webhookDeliveries,
  auditLog,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { TimeoutWorker } from "../services/timeout-worker";
import { WebhookService } from "../services/webhooks";
import { EventBus } from "../services/events";
import { createAuditService } from "../services/audit";

const MON_SLUG = "mon-worker-tpl";

describe("TimeoutWorker monitoring branch", () => {
  let db: any;
  let projectId: string;
  let templateId: string;

  beforeAll(async () => {
    const { db: testDb } = await createTestDb();
    db = testDb;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;

    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: MON_SLUG,
      project_id: projectId,
      name: "Monitoring Worker Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      allow_monitoring: true,
      auto_approve: false,
    }).returning();
    templateId = tpl.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper: seed a fresh monitoring review.
  async function seedMonitoringReview(overrides: Record<string, unknown> = {}) {
    const [row] = await db.insert(reviewsTable).values({
      id: generateId("review"),
      project_id: projectId,
      template_id: templateId,
      template_slug: MON_SLUG,
      payload: { msg: "check this" },
      callback_url: "https://agent.example/cb",
      status: "monitoring",
      oversight: "monitoring",
      irreversibility: "reversible",
      timeout_action: null,
      expires_at: new Date(Date.now() - 5_000), // lapsed by default
      ...overrides,
    }).returning();
    return row;
  }

  // Helper: build a fully-wired worker with optional auditService.
  function makeWorker(overrides: {
    fetchFn?: ReturnType<typeof vi.fn>;
    withAudit?: boolean;
  } = {}) {
    const fetchFn = overrides.fetchFn ?? vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
    const eventBus = new EventBus();
    const auditSvc = overrides.withAudit ? createAuditService(db) : undefined;
    const webhooks = new WebhookService({ db, fetch: fetchFn as any });
    const worker = new TimeoutWorker({ db, webhooks, eventBus, auditService: auditSvc });
    const emitSpy = vi.spyOn(eventBus, "emit");
    return { worker, fetchFn, eventBus, emitSpy };
  }

  // ——————————————————————————————————————————
  // T1: happy path — lapsed review auto-confirmed
  // ——————————————————————————————————————————
  it("auto-confirms a lapsed monitoring review: decided/confirmed, decided_by system:monitoring_window", async () => {
    const review = await seedMonitoringReview();
    const { worker, fetchFn, emitSpy } = makeWorker({ withAudit: true });

    await worker.processMonitoringWindows();

    // Row assertions
    const [updated] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, review.id));
    expect(updated.status).toBe("decided");
    expect(updated.decision).toBe("confirmed");
    expect(updated.decided_by).toBe("system:monitoring_window");
    // The lapse happened when the window closed; the write is materialization.
    expect(updated.decided_at?.getTime()).toBe(review.expires_at.getTime());
    expect(updated.claimed_by).toBeNull();
    expect(updated.claimed_at).toBeNull();

    // Webhook delivery row: event_type review.confirmed with lapsed:true + decided_by
    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.review_id, review.id),
          eq(webhookDeliveries.event_type, "review.confirmed"),
        ),
      );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].payload.lapsed).toBe(true);
    expect(deliveries[0].payload.decided_by).toBe("system:monitoring_window");
    expect(fetchFn).toHaveBeenCalled();

    // Audit log row
    const logs = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.resource_id, review.id),
          eq(auditLog.action, "review.confirmed"),
        ),
      );
    expect(logs).toHaveLength(1);
    expect(logs[0].actor).toBe("system:monitoring_window");
    expect(logs[0].details?.lapsed).toBe(true);

    // EventBus emit
    const confirmedCalls = emitSpy.mock.calls.filter(([evt]) => evt === "review.confirmed");
    expect(confirmedCalls).toHaveLength(1);
    expect(confirmedCalls[0][1]).toMatchObject({
      review_id: review.id,
      decided_by: "system:monitoring_window",
      lapsed: true,
    });
  });

  // ——————————————————————————————————————————
  // T2: in-window review — not touched
  // ——————————————————————————————————————————
  it("does not touch in-window monitoring reviews", async () => {
    const review = await seedMonitoringReview({
      expires_at: new Date(Date.now() + 60_000), // future
    });
    const { worker, emitSpy } = makeWorker();

    await worker.processMonitoringWindows();

    const [unchanged] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, review.id));
    expect(unchanged.status).toBe("monitoring");
    expect(unchanged.decision).toBeNull();

    const confirmedCalls = emitSpy.mock.calls.filter(([evt]) => evt === "review.confirmed");
    expect(confirmedCalls).toHaveLength(0);
  });

  // ——————————————————————————————————————————
  // T3: Race — human veto wins (confirmOne CAS yields 0 rows)
  // ——————————————————————————————————————————
  it("never clobbers a committed human veto (the design-review blocker race)", async () => {
    // Seed a lapsed monitoring review (expires_at in the past so the claim
    // predicate would normally match it).
    const review = await seedMonitoringReview();
    const workerId = "worker-race-1";
    const now = new Date();

    // Simulate the worker's claim: stamp claimed_by + claimed_at (exactly what
    // processMonitoringWindows does before calling confirmOne).
    await db
      .update(reviewsTable)
      .set({ claimed_by: workerId, claimed_at: now })
      .where(eq(reviewsTable.id, review.id));

    // Capture the stale snapshot the worker would hold at this point.
    const [staleRow] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, review.id));

    // Human veto arrives: flip the row to decided/vetoed and clear claimed_by —
    // exactly what the POST /veto endpoint does via its CAS UPDATE.
    await db
      .update(reviewsTable)
      .set({
        status: "decided",
        decision: "vetoed",
        decided_by: "alice@example.com",
        decided_at: new Date(),
        updated_at: new Date(),
        claimed_by: null,
        claimed_at: null,
      })
      .where(eq(reviewsTable.id, review.id));

    // Now call confirmOne with the STALE pre-veto snapshot.
    const { worker, fetchFn, emitSpy } = makeWorker();
    await (worker as any).confirmOne(staleRow, workerId);

    // The veto must still be in place.
    const [afterRace] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, review.id));
    expect(afterRace.decision).toBe("vetoed");
    expect(afterRace.decided_by).toBe("alice@example.com");

    // Zero review.confirmed webhook deliveries.
    const confirmedDeliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.review_id, review.id),
          eq(webhookDeliveries.event_type, "review.confirmed"),
        ),
      );
    expect(confirmedDeliveries).toHaveLength(0);

    // No review.confirmed on the bus.
    const confirmedEmits = emitSpy.mock.calls.filter(([evt]) => evt === "review.confirmed");
    expect(confirmedEmits).toHaveLength(0);
  });

  // ——————————————————————————————————————————
  // T3b: stale-lease steal — another worker holds the claim
  // ——————————————————————————————————————————
  it("does nothing when another worker stole the lease (claimed_by mismatch)", async () => {
    // Row is still status='monitoring' but worker-B re-claimed it (e.g. after
    // worker-A's lease went stale). worker-A's confirmOne with its stale
    // snapshot must match zero rows and produce zero side effects.
    const review = await seedMonitoringReview();

    // worker-A claims, snapshot captured.
    await db
      .update(reviewsTable)
      .set({ claimed_by: "worker-A", claimed_at: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(reviewsTable.id, review.id));
    const [staleRowClaimedByA] = await db
      .select()
      .from(reviewsTable)
      .where(eq(reviewsTable.id, review.id));

    // worker-B steals the stale lease.
    await db
      .update(reviewsTable)
      .set({ claimed_by: "worker-B", claimed_at: new Date() })
      .where(eq(reviewsTable.id, review.id));

    const { worker, fetchFn, emitSpy } = makeWorker();
    await (worker as any).confirmOne(staleRowClaimedByA, "worker-A");

    // Row untouched: still monitoring, still worker-B's claim.
    const [after] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, review.id));
    expect(after.status).toBe("monitoring");
    expect(after.decision).toBeNull();
    expect(after.claimed_by).toBe("worker-B");

    // Zero side effects.
    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.review_id, review.id));
    expect(deliveries).toHaveLength(0);
    expect(fetchFn).not.toHaveBeenCalled();
    const confirmedEmits = emitSpy.mock.calls.filter(([evt]) => evt === "review.confirmed");
    expect(confirmedEmits).toHaveLength(0);
  });

  // ——————————————————————————————————————————
  // T4: existing passes never grab monitoring rows
  // ——————————————————————————————————————————
  it("expiry, ladder, and orphan-reclaim passes never grab monitoring rows", async () => {
    const review = await seedMonitoringReview();
    const { worker } = makeWorker();

    await worker.processExpired();
    await worker.processLadderPromotions();
    await worker.reclaimOrphanedExternalReviews();

    const [unchanged] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, review.id));
    expect(unchanged.status).toBe("monitoring");
  });

  // ——————————————————————————————————————————
  // T5: tick() reports confirmed count
  // ——————————————————————————————————————————
  it("tick() reports the confirmed count", async () => {
    await seedMonitoringReview();
    const { worker } = makeWorker();

    const result = await worker.tick();

    expect(result).toHaveProperty("confirmed");
    expect(result.confirmed).toBeGreaterThanOrEqual(1);
  });
});

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  auditLog,
  chainRuns,
  chainSteps,
  reviews,
  templates,
  webhookDeliveries,
} from "@gatewerk/db/src/schema/index";
import { generateId, InvalidRequestError, type ChainDefinition } from "@gatewerk/shared";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { ChainEngine } from "../services/chain-engine";
import { EventBus } from "../services/events";
import { WebhookService } from "../services/webhooks";
import { createAuditService } from "../services/audit";

// Chain engine lifecycle recovery: expired-step handling, atomic-claim guard,
// transactional createRun, and step_halted audit/webhook emission.

async function makeEngine(db: any) {
  const webhooks = new WebhookService({
    db,
    fetch: async () => new Response("", { status: 204 }) as any,
  });
  const eventBus = new EventBus();
  const auditService = createAuditService(db);
  const engine = new ChainEngine({ db, webhooks, eventBus, auditService });
  engine.subscribe(eventBus);
  return { engine, eventBus, webhooks, auditService };
}

async function seedTemplates(db: any, projectId: string, count = 3) {
  const slugs: string[] = [];
  for (let i = 1; i <= count; i++) {
    const slug = `rec_tpl_${i}`;
    await db.insert(templates).values({
      id: generateId("template"),
      slug,
      project_id: projectId,
      name: `Recovery Template ${i}`,
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });
    slugs.push(slug);
  }
  return slugs;
}

function oneStepDef(slug: string, stepPolicy?: string): ChainDefinition {
  return {
    version: "1.0",
    mode: "sequential",
    rejection_policy: "terminate",
    steps: [
      {
        id: "s1",
        template: slug,
        assignee: { kind: "user", email: "alice@x.com" },
        ...(stepPolicy ? { rejection_policy: stepPolicy as "abort" } : {}),
      },
    ],
  };
}

function twoStepDef(slugs: string[]): ChainDefinition {
  return {
    version: "1.0",
    mode: "sequential",
    rejection_policy: "terminate",
    steps: [
      { id: "s1", template: slugs[0], assignee: { kind: "user", email: "alice@x.com" } },
      { id: "s2", template: slugs[1], assignee: { kind: "user", email: "bob@x.com" } },
    ],
  };
}

async function flushAsync() {
  await new Promise((r) => setTimeout(r, 80));
}

// ---------------------------------------------------------------------------
// Step 1: subscribe registers review.expired handler
// ---------------------------------------------------------------------------
describe("ChainEngine subscribe", () => {
  it("registers a review.expired handler on the EventBus", async () => {
    const { db } = await createTestDb();
    const { eventBus } = await makeEngine(db);
    const spy = vi.spyOn(eventBus, "on");
    // Create a fresh engine to capture .on calls
    const webhooks = new WebhookService({ db, fetch: async () => new Response("", { status: 204 }) as any });
    const auditService = createAuditService(db);
    const engine2 = new ChainEngine({ db, webhooks, eventBus, auditService });
    engine2.subscribe(eventBus);
    const expiredCall = spy.mock.calls.find(([event]) => event === "review.expired");
    expect(expiredCall).toBeDefined();
    const decidedCall = spy.mock.calls.find(([event]) => event === "review.decided");
    expect(decidedCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Steps 2 & 3: onReviewExpired — rejection policy + idempotency
// ---------------------------------------------------------------------------
describe("ChainEngine onReviewExpired", () => {
  let db: any;
  let projectId: string;
  let engine: ChainEngine;
  let slugs: string[];

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    slugs = await seedTemplates(db, projectId);
    ({ engine } = await makeEngine(db));
  });

  beforeEach(async () => {
    await db.delete(webhookDeliveries);
    await db.delete(auditLog);
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
  });

  it("expired chain step with abort policy → run becomes rejected", async () => {
    const result = await engine.createRun({
      definition: oneStepDef(slugs[0], "abort"),
      initial_payload: {},
      project_id: projectId,
      created_by: "agent:test",
    });

    await (engine as any).onReviewExpired({
      review_id: result.step_1_review_id,
      template: slugs[0],
      project_id: projectId,
      priority: "normal",
      created_at: new Date().toISOString(),
    });

    const [run] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    expect(run.status).toBe("rejected");

    const [step] = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    expect(step.status).toBe("rejected");
  });

  it("second review.expired for same step is a no-op (idempotent)", async () => {
    const result = await engine.createRun({
      definition: oneStepDef(slugs[0], "abort"),
      initial_payload: {},
      // callback_url so the abort path emits chain.rejected + chain.step_rejected
      // webhook_deliveries rows we can count for the no-op assertion.
      callback_url: "https://hooks.example.com/x",
      project_id: projectId,
      created_by: "agent:test",
    });

    const eventData = {
      review_id: result.step_1_review_id,
      template: slugs[0],
      project_id: projectId,
      priority: "normal" as const,
      created_at: new Date().toISOString(),
    };

    await (engine as any).onReviewExpired(eventData);
    await flushAsync(); // let fire-and-forget audits + webhook deliveries settle

    // Snapshot side-effect row counts after the first (real) emit.
    const auditBefore = await db.select().from(auditLog);
    const deliveriesBefore = await db.select().from(webhookDeliveries);
    expect(auditBefore.length).toBeGreaterThan(0); // first emit DID do work
    expect(deliveriesBefore.length).toBeGreaterThan(0);

    // Second call — step is already 'rejected', WHERE status='active' matches 0 rows.
    await expect((engine as any).onReviewExpired(eventData)).resolves.not.toThrow();
    await flushAsync();

    // No new audit rows, no new webhook deliveries — truly a no-op.
    const auditAfter = await db.select().from(auditLog);
    const deliveriesAfter = await db.select().from(webhookDeliveries);
    expect(auditAfter.length).toBe(auditBefore.length);
    expect(deliveriesAfter.length).toBe(deliveriesBefore.length);

    const [run] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    expect(run.status).toBe("rejected"); // still rejected, not double-processed
  });

  it("review.expired for non-chain review is a no-op", async () => {
    // Insert a standalone review (no chain_run_id)
    const tplRows = await db.select().from(templates).where(eq(templates.project_id, projectId));
    const tpl = tplRows[0];
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: tpl.id,
      template_slug: tpl.slug,
      payload: {},
      priority: "normal",
      actions: ["approve", "reject"],
      status: "pending",
      current_version: 1,
      ladder_index: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });

    await expect(
      (engine as any).onReviewExpired({
        review_id: reviewId,
        template: tpl.slug,
        project_id: projectId,
        priority: "normal",
        created_at: new Date().toISOString(),
      }),
    ).resolves.not.toThrow();

    // No chain runs affected
    const runs = await db.select().from(chainRuns);
    expect(runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Step 4: atomic-claim guard in onReviewDecided
// ---------------------------------------------------------------------------
describe("ChainEngine onReviewDecided — atomic claim", () => {
  let db: any;
  let projectId: string;
  let engine: ChainEngine;
  let slugs: string[];

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    slugs = await seedTemplates(db, projectId);
    ({ engine } = await makeEngine(db));
  });

  beforeEach(async () => {
    await db.delete(webhookDeliveries);
    await db.delete(auditLog);
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
  });

  it("concurrent onReviewDecided for same step only advances once", async () => {
    const result = await engine.createRun({
      definition: twoStepDef(slugs),
      initial_payload: {},
      project_id: projectId,
      created_by: "agent:test",
    });

    await db.update(reviews).set({
      status: "decided",
      decision: "approved",
      decided_by: "alice",
      decided_at: new Date(),
      updated_at: new Date(),
    }).where(eq(reviews.id, result.step_1_review_id));

    const eventData = {
      review_id: result.step_1_review_id,
      template: slugs[0],
      project_id: projectId,
      priority: "normal" as const,
      created_at: new Date().toISOString(),
    };

    // Both fire — atomic claim means second returns without advancing
    await Promise.all([
      engine.onReviewDecided(eventData as any),
      engine.onReviewDecided(eventData as any),
    ]);

    // Only one step 2 should be active (not duplicated)
    const allSteps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step2Rows = allSteps.filter((s: any) => s.step_number === 2);
    expect(step2Rows).toHaveLength(1);

    const activeReviews = await db.select().from(reviews)
      .where(and(eq(reviews.chain_run_id, result.chain_run_id), eq(reviews.status, "pending")));
    // Only one step-2 review should exist (no double materialization)
    expect(activeReviews).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Step 5: createRun wraps inserts in a transaction
// ---------------------------------------------------------------------------
describe("ChainEngine createRun — transactional atomicity", () => {
  let db: any;
  let projectId: string;
  let engine: ChainEngine;
  let slugs: string[];

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    slugs = await seedTemplates(db, projectId);
    ({ engine } = await makeEngine(db));
  });

  beforeEach(async () => {
    await db.delete(webhookDeliveries);
    await db.delete(auditLog);
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
  });

  it("chain_runs row is rolled back when chain_steps insert fails", async () => {
    // A branch step on step 1 violates chain_steps_rejection_branch_to_chk:
    // branch requires rejection_branch_to < step_number; for step 1 that's
    // < 1, but branch_to must also be > 0 — no valid value exists.
    // This forces a real DB constraint violation inside the transaction.
    const brokenDef = {
      version: "1.0",
      mode: "sequential",
      rejection_policy: "abort",
      steps: [
        {
          id: "s1",
          template: slugs[0],
          assignee: { kind: "user", email: "test@x.com" },
          rejection_policy: "branch",
          rejection_branch_to: 1, // violates CHECK: requires < step_number=1
        },
      ],
    } as unknown as ChainDefinition;

    await expect(
      engine.createRun({
        definition: brokenDef,
        initial_payload: {},
        project_id: projectId,
        created_by: "test",
      }),
    ).rejects.toThrow();

    const runs = await db.select().from(chainRuns);
    expect(runs).toHaveLength(0); // transaction rolled back; no orphan chain_runs row
  });
});

// ---------------------------------------------------------------------------
// Step 6: emitStepHalted — materialize_error path
// ---------------------------------------------------------------------------
describe("ChainEngine emitStepHalted", () => {
  let db: any;
  let projectId: string;
  let engine: ChainEngine;
  let slugs: string[];

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    slugs = await seedTemplates(db, projectId, 2);
    ({ engine } = await makeEngine(db));
  });

  beforeEach(async () => {
    await db.delete(webhookDeliveries);
    await db.delete(auditLog);
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
  });

  it("template_not_found error emits chain.step_halted audit with reason=materialize_error", async () => {
    const result = await engine.createRun({
      definition: twoStepDef(slugs),
      initial_payload: {},
      project_id: projectId,
      created_by: "agent:test",
    });

    // Delete step-2 template so materializeStep throws template_not_found
    // C1: every step materialises against the ENTRY template, so deleting
    // that is what makes the next materialisation throw. Deleting a later
    // step's template no longer breaks anything, because nothing reads it.
    await db.delete(templates).where(eq(templates.slug, slugs[0]));

    // Approve step 1 — triggers onReviewDecided → handleApprove → materializeStep → throw
    await db.update(reviews).set({
      status: "decided",
      decision: "approved",
      decided_by: "alice",
      decided_at: new Date(),
      updated_at: new Date(),
    }).where(eq(reviews.id, result.step_1_review_id));

    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0],
      project_id: projectId,
      priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    await flushAsync(); // let fire-and-forget audit settle

    const haltedAudit = await db.select().from(auditLog)
      .where(eq(auditLog.action, "chain.step_halted"));
    expect(haltedAudit).toHaveLength(1);
    expect((haltedAudit[0].details as any).reason).toBe("materialize_error");
  });

  it("auth_level error still emits chain.step_halted with reason=auth_tier_invariant", async () => {
    // auth_level.* errors come from the token resolution path. Simulate by
    // calling emitStepHalted directly with a crafted error.
    // Spy on auditService.log to capture the call args directly.
    const { engine: eng2, auditService: audit2 } = await makeEngine(db);
    const logSpy = vi.spyOn(audit2, "log");

    // InvalidRequestError(message, param?, code): param=field, code=error code
    const authErr = new InvalidRequestError(
      "auth tier mismatch",
      "assignee.auth_level",
      "auth_level.email_required",
    );

    await (eng2 as any).emitStepHalted(
      {
        review_id: generateId("review"),
        template: "tpl",
        project_id: projectId,
        priority: "normal",
        created_at: new Date().toISOString(),
      },
      authErr,
    );

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "chain.step_halted",
        details: expect.objectContaining({
          reason: "auth_tier_invariant",
          code: "auth_level.email_required",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Step 8: branch sets prev_step_ids=[] on re-materialized review
// ---------------------------------------------------------------------------
describe("ChainEngine branch rejection — prev_step_ids", () => {
  let db: any;
  let projectId: string;
  let engine: ChainEngine;
  let slugs: string[];

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    slugs = await seedTemplates(db, projectId, 3);
    ({ engine } = await makeEngine(db));
  });

  beforeEach(async () => {
    await db.delete(webhookDeliveries);
    await db.delete(auditLog);
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
  });

  it("branch re-materializes target step with prev_step_ids=[]", async () => {
    // 3-step chain: step 3 branches back to step 1 on rejection
    const def: ChainDefinition = {
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        { id: "s1", template: slugs[0], assignee: { kind: "user", email: "alice@x.com" } },
        { id: "s2", template: slugs[1], assignee: { kind: "user", email: "bob@x.com" } },
        {
          id: "s3",
          template: slugs[2],
          assignee: { kind: "user", email: "carol@x.com" },
          rejection_policy: "branch",
          rejection_branch_to: 1,
        },
      ],
    };

    const result = await engine.createRun({
      definition: def,
      initial_payload: { content: "data" },
      project_id: projectId,
      created_by: "agent:test",
    });

    // Approve step 1
    await db.update(reviews).set({
      status: "decided", decision: "approved",
      decided_by: "alice", decided_at: new Date(), updated_at: new Date(),
    }).where(eq(reviews.id, result.step_1_review_id));
    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    // Get step 2 review and approve it
    let steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step2 = steps.find((s: any) => s.step_number === 2);
    await db.update(reviews).set({
      status: "decided", decision: "approved",
      decided_by: "bob", decided_at: new Date(), updated_at: new Date(),
    }).where(eq(reviews.id, step2.review_id));
    await engine.onReviewDecided({
      review_id: step2.review_id,
      template: slugs[1], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    // Get step 3 review and reject it (triggers branch to step 1)
    steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step3 = steps.find((s: any) => s.step_number === 3);
    await db.update(reviews).set({
      status: "decided", decision: "rejected",
      decided_by: "carol", decided_at: new Date(),
      feedback: "start over", updated_at: new Date(),
    }).where(eq(reviews.id, step3.review_id));
    await engine.onReviewDecided({
      review_id: step3.review_id,
      template: slugs[2], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    // Step 1 should be re-materialized with a NEW review
    steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step1After = steps.find((s: any) => s.step_number === 1);
    expect(step1After!.review_id).not.toBe(result.step_1_review_id);
    expect(step1After!.status).toBe("active");

    // The new review for step 1 (re-materialized via branch) should have prev_step_ids=[]
    const [newStep1Review] = await db.select().from(reviews)
      .where(eq(reviews.id, step1After!.review_id!));
    expect(newStep1Review.prev_step_ids).toEqual([]);
  });
});

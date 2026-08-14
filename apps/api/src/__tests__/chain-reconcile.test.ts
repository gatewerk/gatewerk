import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  auditLog,
  chainRuns,
  chainSteps,
  reviews,
  templates,
  webhookDeliveries,
} from "@gatewerk/db/src/schema/index";
import { generateId, type ChainDefinition } from "@gatewerk/shared";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { ChainEngine } from "../services/chain-engine";
import { EventBus } from "../services/events";
import { WebhookService } from "../services/webhooks";
import { createAuditService } from "../services/audit";

// Chain engine crash-reconciliation sweep: re-drives stranded active steps
// whose review is already terminal (decided/expired) but whose chain event
// was lost due to an in-process EventBus crash between the terminal write
// and the handler.

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

function twoStepDef(slug1: string, slug2: string): ChainDefinition {
  return {
    version: "1.0",
    mode: "sequential",
    rejection_policy: "terminate",
    steps: [
      {
        id: "s1",
        template: slug1,
        assignee: { kind: "user", email: "alice@x.com" },
        rejection_policy: "abort",
      },
      {
        id: "s2",
        template: slug2,
        assignee: { kind: "user", email: "alice@x.com" },
        rejection_policy: "abort",
      },
    ],
  };
}

describe("ChainEngine reconcile", () => {
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

  it("re-drives a decided review whose chain event was lost", async () => {
    const result = await engine.createRun({
      definition: twoStepDef(slugs[0], slugs[1]),
      initial_payload: {},
      project_id: projectId,
      created_by: "agent:test",
    });

    // Simulate the crash: review decided directly in DB, NO event emitted.
    await db.update(reviews)
      .set({ status: "decided", decision: "approved", decided_by: "reviewer:x", decided_at: new Date() })
      .where(eq(reviews.id, result.step_1_review_id));

    const stats = await engine.reconcile();
    expect(stats.redriven).toBe(1);

    const steps = await db.select().from(chainSteps)
      .where(eq(chainSteps.chain_run_id, result.chain_run_id))
      .orderBy(chainSteps.step_number);
    expect(steps[0].status).toBe("approved");
    expect(steps[1].status).toBe("active");
  });

  it("is idempotent, second reconcile is a no-op", async () => {
    const result = await engine.createRun({
      definition: twoStepDef(slugs[0], slugs[1]),
      initial_payload: {},
      project_id: projectId,
      created_by: "agent:test",
    });

    await db.update(reviews)
      .set({ status: "decided", decision: "approved", decided_by: "reviewer:x", decided_at: new Date() })
      .where(eq(reviews.id, result.step_1_review_id));

    const stats1 = await engine.reconcile();
    expect(stats1.redriven).toBe(1);

    // Second call: step 1 is now 'approved', step 2's review is 'pending' (live)
    // → no stranded steps → true no-op
    const stats2 = await engine.reconcile();
    expect(stats2.redriven).toBe(0);
    expect(stats2.halted).toBe(0);
  });

  it("treats a stranded expired review via the rejection path", async () => {
    const result = await engine.createRun({
      definition: oneStepDef(slugs[0], "abort"),
      initial_payload: {},
      project_id: projectId,
      created_by: "agent:test",
    });

    await db.update(reviews)
      .set({ status: "expired", decision: "expired" })
      .where(eq(reviews.id, result.step_1_review_id));

    await engine.reconcile();

    const [run] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    expect(run.status).toBe("rejected");
  });

  it("re-drives a decided review with decision=edited (legacy decide path)", async () => {
    // Legacy POST /decide with action=approve + payload edit sets decision="edited"
    // (execute-action.ts additionalFields override). The chain must still advance.
    const result = await engine.createRun({
      definition: twoStepDef(slugs[0], slugs[1]),
      initial_payload: {},
      project_id: projectId,
      created_by: "agent:test",
    });

    await db.update(reviews)
      .set({ status: "decided", decision: "edited", decided_by: "reviewer:x", decided_at: new Date() })
      .where(eq(reviews.id, result.step_1_review_id));

    const stats = await engine.reconcile();
    expect(stats.redriven).toBe(1);

    const steps = await db.select().from(chainSteps)
      .where(eq(chainSteps.chain_run_id, result.chain_run_id))
      .orderBy(chainSteps.step_number);
    expect(steps[0].status).toBe("approved");
    expect(steps[1].status).toBe("active");

    // Second reconcile: step 1 approved, step 2 review pending (live) → no-op
    const stats2 = await engine.reconcile();
    expect(stats2.redriven).toBe(0);
    expect(stats2.halted).toBe(0);
  });

  it("terminates a NULL-review_id orphan step once and is idempotent", async () => {
    // Simulate a step that was never fully materialized: chain_run is active,
    // chain_step is active but review_id is NULL (crash between transaction
    // commit and materializeStep). Reconcile must halt + flip to 'skipped'
    // exactly once, not emit audit/webhook spam on every sweep.
    const runId = generateId("chain_run");
    const stepId = generateId("chain_step");
    await db.insert(chainRuns).values({
      id: runId,
      project_id: projectId,
      template_id: null,
      name: null,
      mode: "sequential",
      rejection_policy: "abort",
      status: "active",
      metadata: null,
      created_by: "test",
      created_at: new Date(),
    });
    await db.insert(chainSteps).values({
      id: stepId,
      chain_run_id: runId,
      step_number: 1,
      review_id: null,
      assignee_spec: { template: slugs[0], assignee: { kind: "user", email: "x@x.com" } },
      depends_on: null,
      status: "active",
      materialized_at: null,
      rejection_policy: "abort",
      rejection_branch_to: null,
    });

    const stats1 = await engine.reconcile();
    expect(stats1.halted).toBe(1);
    expect(stats1.redriven).toBe(0);

    const [step] = await db.select().from(chainSteps).where(eq(chainSteps.id, stepId));
    expect(step.status).toBe("skipped");

    // Second reconcile: step is 'skipped', not 'active' → no-op
    const stats2 = await engine.reconcile();
    expect(stats2.redriven).toBe(0);
    expect(stats2.halted).toBe(0);
  });
});

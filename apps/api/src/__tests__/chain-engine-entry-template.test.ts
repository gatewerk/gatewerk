import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
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

// C1 (route model): a chain is a ROUTE OF APPROVERS over one request. Every
// step materialises a review against the chain's ENTRY template, never against
// a template the step names for itself.
//
// This file also pins the two worker landmines the route model puts in reach:
// a chain step must never carry an auto_approve timeout action, and must never
// inherit max_iterations. Both would let a background worker decide a chain
// step and advance the run, breaking "chain advancement is human-only by
// construction".

function createEngine(db: any) {
  const webhooks = new WebhookService({
    db,
    fetch: async () => new Response("", { status: 204 }) as any,
  });
  const eventBus = new EventBus();
  const engine = new ChainEngine({ db, webhooks, eventBus });
  engine.subscribe(eventBus);
  return { engine, eventBus };
}

/** Decide a review the way the real decision path does, then drive the engine. */
async function approve(db: any, engine: ChainEngine, reviewId: string, by: string) {
  await db
    .update(reviews)
    .set({
      status: "decided",
      decision: "approved",
      decided_by: by,
      decided_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(reviews.id, reviewId));
  await engine.onReviewDecided({ review_id: reviewId } as any);
  await new Promise((r) => setTimeout(r, 50));
}

describe("ChainEngine — the route resolves one entry template", () => {
  let db: any;
  let projectId: string;
  let engine: ChainEngine;
  let entryTemplateId: string;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;

    entryTemplateId = generateId("template");
    await db.insert(templates).values({
      id: entryTemplateId,
      slug: "entry_tpl",
      project_id: projectId,
      name: "Entry",
      fields: [{ name: "amount", type: "number", label: "Amount" }],
      actions: ["approve", "reject"],
      // The landmine: a template that auto-approves on timeout. The worker's
      // auto_approve branch emits review.decided, which the engine subscribes
      // to its ADVANCE handler.
      timeout_action: "auto_approve",
      max_iterations: 3,
    });
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "other_tpl",
      project_id: projectId,
      name: "Other",
      fields: [{ name: "note", type: "text", label: "Note" }],
      actions: ["approve", "reject"],
    });
  });

  beforeEach(async () => {
    await db.delete(webhookDeliveries);
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
    const e = createEngine(db);
    engine = e.engine;
  });

  const routeDefinition = (overrides?: Partial<ChainDefinition>): ChainDefinition =>
    ({
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      template: "entry_tpl",
      steps: [
        { id: "s1", assignee: { kind: "user", email: "junior@corp.co" } },
        // A legacy per-step template that C1 must now IGNORE.
        { id: "s2", template: "other_tpl", assignee: { kind: "user", email: "senior@corp.co" } },
      ],
      ...overrides,
    }) as ChainDefinition;

  it("materialises every step against the entry template, not the step's", async () => {
    const run = await engine.createRun({
      definition: routeDefinition(),
      initial_payload: { amount: 100 },
      project_id: projectId,
      created_by: "reviewer:admin@corp.co",
    });

    const [step1] = await db.select().from(reviews).where(eq(reviews.id, run.step_1_review_id));
    expect(step1.template_slug).toBe("entry_tpl");

    await approve(db, engine, step1.id, "junior@corp.co");

    const all = await db.select().from(reviews).where(eq(reviews.chain_run_id, run.chain_run_id));
    expect(all).toHaveLength(2);
    const step2 = all.find((r: any) => r.id !== step1.id)!;
    expect(step2.template_slug).toBe("entry_tpl");
    expect(step2.assignee).toBe("senior@corp.co");
  });

  it("records the entry template on the run", async () => {
    const run = await engine.createRun({
      definition: routeDefinition(),
      initial_payload: { amount: 100 },
      project_id: projectId,
      created_by: "reviewer:admin@corp.co",
    });
    const [row] = await db.select().from(chainRuns).where(eq(chainRuns.id, run.chain_run_id));
    expect(row.template_id).toBe(entryTemplateId);
  });

  it("honours an explicit entry_template_slug over the definition envelope", async () => {
    const run = await engine.createRun({
      definition: routeDefinition({ template: "other_tpl" } as Partial<ChainDefinition>),
      initial_payload: { amount: 100 },
      project_id: projectId,
      created_by: "reviewer:admin@corp.co",
      entry_template_slug: "entry_tpl",
    });
    const [step1] = await db.select().from(reviews).where(eq(reviews.id, run.step_1_review_id));
    expect(step1.template_slug).toBe("entry_tpl");
  });

  it("falls back to steps[0].template for a legacy definition with no envelope template", async () => {
    const legacy = {
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        { id: "s1", template: "entry_tpl", assignee: { kind: "user", email: "junior@corp.co" } },
        { id: "s2", template: "other_tpl", assignee: { kind: "user", email: "senior@corp.co" } },
      ],
    } as ChainDefinition;

    const run = await engine.createRun({
      definition: legacy,
      initial_payload: { amount: 100 },
      project_id: projectId,
      created_by: "reviewer:admin@corp.co",
    });
    const [step1] = await db.select().from(reviews).where(eq(reviews.id, run.step_1_review_id));
    expect(step1.template_slug).toBe("entry_tpl");

    await approve(db, engine, step1.id, "junior@corp.co");
    const all = await db.select().from(reviews).where(eq(reviews.chain_run_id, run.chain_run_id));
    const step2 = all.find((r: any) => r.id !== step1.id)!;
    // Step 2 inherits step 1's template under the route model, not other_tpl.
    expect(step2.template_slug).toBe("entry_tpl");
  });

  it("refuses a definition that names no template at all", async () => {
    await expect(
      engine.createRun({
        definition: {
          version: "1.0",
          mode: "sequential",
          rejection_policy: "terminate",
          steps: [{ id: "s1", assignee: { kind: "user", email: "junior@corp.co" } }],
        } as ChainDefinition,
        initial_payload: {},
        project_id: projectId,
        created_by: "reviewer:admin@corp.co",
      }),
    ).rejects.toThrow(/template/i);
  });

  it("never lets a worker decide a chain step: timeout_action is pinned to expire", async () => {
    const run = await engine.createRun({
      definition: routeDefinition(),
      initial_payload: { amount: 100 },
      project_id: projectId,
      created_by: "reviewer:admin@corp.co",
    });
    const [step1] = await db.select().from(reviews).where(eq(reviews.id, run.step_1_review_id));

    // The entry template says auto_approve. A chain step must not carry it:
    // the worker's auto_approve branch emits review.decided, and the engine
    // subscribes review.decided to its ADVANCE handler.
    expect(step1.timeout_action).toBe("expire");
    // Still unwritten, so the worker's claim query cannot see the row at all.
    expect(step1.expires_at).toBeNull();
    // Not inherited: closeMaxIterations has no expires_at gate and emits a
    // decision value onReviewDecided does not handle.
    expect(step1.max_iterations).toBeNull();

    await approve(db, engine, step1.id, "junior@corp.co");
    const all = await db.select().from(reviews).where(eq(reviews.chain_run_id, run.chain_run_id));
    const step2 = all.find((r: any) => r.id !== step1.id)!;
    expect(step2.timeout_action).toBe("expire");
    expect(step2.max_iterations).toBeNull();
  });
});

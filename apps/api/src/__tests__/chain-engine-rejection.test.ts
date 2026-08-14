import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  chainRuns,
  chainSteps,
  reviews,
  templates,
} from "@gatewerk/db/src/schema/index";
import { generateId, type ChainDefinition } from "@gatewerk/shared";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { ChainEngine } from "../services/chain-engine";
import { EventBus } from "../services/events";
import { WebhookService } from "../services/webhooks";
import { createAuditService } from "../services/audit";

// Rejection-policy coverage (M10 Phase 1). Only `terminate` has engine logic
// this milestone — back_one and restart are validated by zod but the engine
// falls back to terminate with a console warning (implementation is M13).
// The terminate path:
//   * flips chain_runs.status to 'rejected' and sets completed_at
//   * flips the rejecting chain_steps row to 'rejected'
//   * does NOT materialise further steps

async function makeEngine(db: any) {
  const webhooks = new WebhookService({
    db,
    fetch: async () => new Response("", { status: 204 }) as any,
  });
  const eventBus = new EventBus();
  const auditService = createAuditService(db);
  const engine = new ChainEngine({ db, webhooks, eventBus, auditService });
  engine.subscribe(eventBus);
  return { engine };
}

function twoStepDef(slugs: string[], rejection_policy: "terminate" | "back_one" | "restart" = "terminate"): ChainDefinition {
  return {
    version: "1.0",
    mode: "sequential",
    rejection_policy,
    steps: [
      { id: "s1", template: slugs[0], assignee: { kind: "user", email: "alice@x.com" } },
      { id: "s2", template: slugs[1], assignee: { kind: "user", email: "bob@x.com" } },
    ],
  };
}

async function seedTwoTemplates(db: any, projectId: string) {
  const slugs = ["reject_tpl_1", "reject_tpl_2"];
  for (const slug of slugs) {
    await db.insert(templates).values({
      id: generateId("template"),
      slug,
      project_id: projectId,
      name: slug,
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });
  }
  return slugs;
}

describe("ChainEngine — terminate policy", () => {
  let db: any;
  let projectId: string;
  let engine: ChainEngine;
  let slugs: string[];

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    slugs = await seedTwoTemplates(db, projectId);
    ({ engine } = await makeEngine(db));
  });

  beforeEach(async () => {
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
  });

  it("rejecting step 1 terminates the chain (status=rejected, completed_at set)", async () => {
    const result = await engine.createRun({
      definition: twoStepDef(slugs),
      initial_payload: { content: "x" },
      project_id: projectId,
      created_by: "agent:test",
    });

    await db.update(reviews).set({
      status: "decided",
      decision: "rejected",
      decided_by: "alice",
      decided_at: new Date(),
      feedback: "budget too high",
      updated_at: new Date(),
    }).where(eq(reviews.id, result.step_1_review_id));

    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    const [run] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    expect(run.status).toBe("rejected");
    expect(run.completed_at).not.toBeNull();

    const steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const byNumber = steps.sort((a: any, b: any) => a.step_number - b.step_number);
    expect(byNumber[0].status).toBe("rejected");
    // Step 2 stays pending — no materialisation after rejection
    expect(byNumber[1].status).toBe("pending");
    expect(byNumber[1].review_id).toBeNull();
  });

  it("rejecting step 2 terminates the chain; step 1 stays approved", async () => {
    const result = await engine.createRun({
      definition: twoStepDef(slugs),
      initial_payload: {},
      project_id: projectId,
      created_by: "agent:test",
    });

    // Approve step 1 → materialises step 2
    await db.update(reviews).set({
      status: "decided", decision: "approved",
      decided_by: "alice", decided_at: new Date(), updated_at: new Date(),
    }).where(eq(reviews.id, result.step_1_review_id));
    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    // Reject step 2
    let steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step2 = steps.find((s: any) => s.step_number === 2);
    await db.update(reviews).set({
      status: "decided", decision: "rejected",
      decided_by: "bob", decided_at: new Date(),
      feedback: "no", updated_at: new Date(),
    }).where(eq(reviews.id, step2.review_id));
    await engine.onReviewDecided({
      review_id: step2.review_id,
      template: slugs[1], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    const [run] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    expect(run.status).toBe("rejected");

    steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const byNumber = steps.sort((a: any, b: any) => a.step_number - b.step_number);
    expect(byNumber[0].status).toBe("approved");
    expect(byNumber[1].status).toBe("rejected");
  });

  it("back_one policy falls back to terminate (M10: M13 implements back_one)", async () => {
    const result = await engine.createRun({
      definition: twoStepDef(slugs, "back_one"),
      initial_payload: {},
      project_id: projectId,
      created_by: "agent:test",
    });

    await db.update(reviews).set({
      status: "decided", decision: "rejected",
      decided_by: "alice", decided_at: new Date(), updated_at: new Date(),
    }).where(eq(reviews.id, result.step_1_review_id));
    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    const [run] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    // back_one is not implemented, so M10 terminates
    expect(run.status).toBe("rejected");
    expect(run.completed_at).not.toBeNull();
  });

  it("restart policy falls back to terminate (M10: M13 implements restart)", async () => {
    const result = await engine.createRun({
      definition: twoStepDef(slugs, "restart"),
      initial_payload: {},
      project_id: projectId,
      created_by: "agent:test",
    });

    await db.update(reviews).set({
      status: "decided", decision: "rejected",
      decided_by: "alice", decided_at: new Date(), updated_at: new Date(),
    }).where(eq(reviews.id, result.step_1_review_id));
    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    const [run] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    expect(run.status).toBe("rejected");
  });

  it("onReviewDecided is idempotent on a rejected chain (second call is a no-op)", async () => {
    const result = await engine.createRun({
      definition: twoStepDef(slugs),
      initial_payload: {},
      project_id: projectId,
      created_by: "agent:test",
    });

    await db.update(reviews).set({
      status: "decided", decision: "rejected",
      decided_by: "alice", decided_at: new Date(), updated_at: new Date(),
    }).where(eq(reviews.id, result.step_1_review_id));

    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);
    // Second fire should not error and should not change state
    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    const [run] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    expect(run.status).toBe("rejected");
  });
});

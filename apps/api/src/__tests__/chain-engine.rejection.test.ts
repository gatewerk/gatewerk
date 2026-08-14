import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  auditLog,
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

// M13 per-step rejection policy coverage. The chain-level rejection_policy
// shipped in M10 (chain_runs.rejection_policy) remains; M13 adds a per-step
// override (chain_steps.rejection_policy) with three dispositions:
//
//   'abort'    — terminate the chain (status=rejected). Same as M10.
//   'continue' — advance to the next step as if approved.
//   'branch'   — jump back to `rejection_branch_to` (1-based step_number,
//                must precede the current step — cycle-avoidance invariant
//                enforced by zod at createRun + DB CHECK at insert).
//
// All three dispositions fire a `chain.step_rejected` webhook with payload
//   { chain_run_id, step_index, applied_policy, next_step_index | null }.
// When rejection_policy is NULL the engine defaults to 'abort' to preserve
// pre-M13 chain behaviour (backward compatibility gate).

type DeliveryLog = Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }>;

async function makeEngine(db: any, deliveries: DeliveryLog) {
  const webhooks = new WebhookService({
    db,
    fetch: async (url: any, init: any) => {
      deliveries.push({
        url: String(url),
        body: JSON.parse(init.body),
        headers: init.headers,
      });
      return new Response("", { status: 204 }) as any;
    },
  });
  const eventBus = new EventBus();
  const auditService = createAuditService(db);
  const engine = new ChainEngine({ db, webhooks, eventBus, auditService });
  engine.subscribe(eventBus);
  return { engine };
}

async function seedThreeTemplates(db: any, projectId: string): Promise<string[]> {
  const slugs = ["m13_tpl_a", "m13_tpl_b", "m13_tpl_c"];
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

function threeStepDef(
  slugs: string[],
  policies: Array<{ rejection_policy?: "abort" | "continue" | "branch"; rejection_branch_to?: number }>,
): ChainDefinition {
  return {
    version: "1.0",
    mode: "sequential",
    rejection_policy: "terminate",
    steps: [
      { id: "s1", template: slugs[0], assignee: { kind: "user", email: "alice@x.com" }, ...policies[0] },
      { id: "s2", template: slugs[1], assignee: { kind: "user", email: "bob@x.com" }, ...policies[1] },
      { id: "s3", template: slugs[2], assignee: { kind: "user", email: "carol@x.com" }, ...policies[2] },
    ],
  };
}

async function decide(db: any, reviewId: string, decision: "approved" | "rejected", actor = "user_test", feedback?: string) {
  await db.update(reviews).set({
    status: "decided",
    decision,
    decided_by: actor,
    decided_at: new Date(),
    feedback: feedback ?? null,
    updated_at: new Date(),
  }).where(eq(reviews.id, reviewId));
}

async function fireDecided(engine: ChainEngine, reviewId: string, slug: string, projectId: string) {
  await engine.onReviewDecided({
    review_id: reviewId,
    template: slug,
    project_id: projectId,
    priority: "normal",
    created_at: new Date().toISOString(),
  } as any);
}

function stepRejectedEvents(deliveries: DeliveryLog) {
  return deliveries.filter((d) => d.body.type === "chain.step_rejected");
}

describe("ChainEngine — per-step rejection policy (M13)", () => {
  let db: any;
  let projectId: string;
  let slugs: string[];
  let callbackUrl: string;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    slugs = await seedThreeTemplates(db, projectId);
    callbackUrl = "https://agent.example.com/chain-events";
  });

  beforeEach(async () => {
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
    await db.delete(auditLog);
  });

  it("backward compat: step without rejection_policy defaults to abort (M10 terminate behaviour)", async () => {
    const deliveries: DeliveryLog = [];
    const { engine } = await makeEngine(db, deliveries);

    const result = await engine.createRun({
      definition: threeStepDef(slugs, [{}, {}, {}]),
      initial_payload: { content: "draft" },
      callback_url: callbackUrl,
      project_id: projectId,
      created_by: "agent:test",
    });

    await decide(db, result.step_1_review_id, "rejected", "alice", "no good");
    await fireDecided(engine, result.step_1_review_id, slugs[0], projectId);

    const [run] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    expect(run.status).toBe("rejected");
    expect(run.completed_at).not.toBeNull();

    const steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const byN = steps.sort((a: any, b: any) => a.step_number - b.step_number);
    expect(byN[0].status).toBe("rejected");
    expect(byN[1].status).toBe("pending");
    expect(byN[1].review_id).toBeNull();

    const stepRejected = stepRejectedEvents(deliveries);
    expect(stepRejected).toHaveLength(1);
    expect(stepRejected[0].body).toMatchObject({
      type: "chain.step_rejected",
      chain_run_id: result.chain_run_id,
      step_index: 1,
      applied_policy: "abort",
      next_step_index: null,
    });
  });

  it("abort policy: terminates chain and fires chain.step_rejected with next_step_index=null", async () => {
    const deliveries: DeliveryLog = [];
    const { engine } = await makeEngine(db, deliveries);

    const result = await engine.createRun({
      definition: threeStepDef(slugs, [
        { rejection_policy: "abort" },
        {},
        {},
      ]),
      initial_payload: { content: "x" },
      callback_url: callbackUrl,
      project_id: projectId,
      created_by: "agent:test",
    });

    await decide(db, result.step_1_review_id, "rejected", "alice", "terminate");
    await fireDecided(engine, result.step_1_review_id, slugs[0], projectId);

    const [run] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    expect(run.status).toBe("rejected");
    expect(run.completed_at).not.toBeNull();

    const stepRejected = stepRejectedEvents(deliveries);
    expect(stepRejected).toHaveLength(1);
    expect(stepRejected[0].body).toMatchObject({
      applied_policy: "abort",
      step_index: 1,
      next_step_index: null,
    });
  });

  it("continue policy: advances to next step, chain stays active, webhook carries next_step_index", async () => {
    const deliveries: DeliveryLog = [];
    const { engine } = await makeEngine(db, deliveries);

    const result = await engine.createRun({
      definition: threeStepDef(slugs, [
        { rejection_policy: "continue" },
        {},
        {},
      ]),
      initial_payload: { content: "skip-me" },
      callback_url: callbackUrl,
      project_id: projectId,
      created_by: "agent:test",
    });

    await decide(db, result.step_1_review_id, "rejected", "alice", "not my call");
    await fireDecided(engine, result.step_1_review_id, slugs[0], projectId);

    const [run] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    expect(run.status).toBe("active");
    expect(run.completed_at).toBeNull();

    const steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const byN = steps.sort((a: any, b: any) => a.step_number - b.step_number);
    expect(byN[0].status).toBe("rejected");
    expect(byN[1].status).toBe("active");
    expect(byN[1].review_id).not.toBeNull();
    expect(byN[2].status).toBe("pending");

    const stepRejected = stepRejectedEvents(deliveries);
    expect(stepRejected).toHaveLength(1);
    expect(stepRejected[0].body).toMatchObject({
      applied_policy: "continue",
      step_index: 1,
      next_step_index: 2,
    });

    // A1: chain.step_rejected audit row carries continue policy + next_step_number
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "chain.step_rejected"),
        eq(auditLog.resource_id, result.chain_run_id),
      ));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actor).toBe("alice");
    expect(auditRows[0].resource_type).toBe("chain_run");
    expect(auditRows[0].details).toMatchObject({
      rejecting_step_number: 1,
      applied_step_policy: "continue",
      next_step_number: 2,
    });
    expect(typeof (auditRows[0].details as Record<string, unknown>).rejected_at).toBe("string");
    expect(typeof (auditRows[0].details as Record<string, unknown>).rejecting_step_id).toBe("string");
  });

  it("continue policy at last step: chain completes and audit carries next_step_number=null", async () => {
    const deliveries: DeliveryLog = [];
    const { engine } = await makeEngine(db, deliveries);

    // Step 3 (the last step) carries continue policy. Rejecting it must
    // complete the chain (no successor to advance to) and the audit row
    // must record next_step_number=null.
    const result = await engine.createRun({
      definition: threeStepDef(slugs, [
        {},
        {},
        { rejection_policy: "continue" },
      ]),
      initial_payload: { content: "go" },
      callback_url: callbackUrl,
      project_id: projectId,
      created_by: "agent:test",
    });

    // Approve step 1 → step 2 materialises
    await decide(db, result.step_1_review_id, "approved", "alice");
    await fireDecided(engine, result.step_1_review_id, slugs[0], projectId);
    let steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step2 = steps.find((s: any) => s.step_number === 2);

    // Approve step 2 → step 3 materialises
    await decide(db, step2!.review_id!, "approved", "bob");
    await fireDecided(engine, step2!.review_id!, slugs[1], projectId);
    steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step3 = steps.find((s: any) => s.step_number === 3);

    // Reject step 3 — continue policy with no successor → completeRun
    await decide(db, step3!.review_id!, "rejected", "carol", "skip");
    await fireDecided(engine, step3!.review_id!, slugs[2], projectId);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "chain.step_rejected"),
        eq(auditLog.resource_id, result.chain_run_id),
      ));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].details).toMatchObject({
      rejecting_step_number: 3,
      applied_step_policy: "continue",
      next_step_number: null,
    });
  });

  it("branch policy: jumps back to rejection_branch_to; target step re-materialises with a new review", async () => {
    const deliveries: DeliveryLog = [];
    const { engine } = await makeEngine(db, deliveries);

    // Step 3 rejection branches back to step 1.
    const result = await engine.createRun({
      definition: threeStepDef(slugs, [
        {},
        {},
        { rejection_policy: "branch", rejection_branch_to: 1 },
      ]),
      initial_payload: { content: "flow" },
      callback_url: callbackUrl,
      project_id: projectId,
      created_by: "agent:test",
    });

    // Approve step 1 → step 2 materialises
    await decide(db, result.step_1_review_id, "approved", "alice");
    await fireDecided(engine, result.step_1_review_id, slugs[0], projectId);

    let steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step2Before = steps.find((s: any) => s.step_number === 2);
    const originalStep1ReviewId = result.step_1_review_id;

    // Approve step 2 → step 3 materialises
    await decide(db, step2Before!.review_id!, "approved", "bob");
    await fireDecided(engine, step2Before!.review_id!, slugs[1], projectId);

    steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step3 = steps.find((s: any) => s.step_number === 3);
    expect(step3!.status).toBe("active");

    // Reject step 3 with branch-to-1 — step 1 re-materialises with a new review
    await decide(db, step3!.review_id!, "rejected", "carol", "start over");
    await fireDecided(engine, step3!.review_id!, slugs[2], projectId);

    const [run] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    expect(run.status).toBe("active");
    expect(run.completed_at).toBeNull();

    steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const byN = steps.sort((a: any, b: any) => a.step_number - b.step_number);
    // The rejecting step resets to 'pending', NOT 'rejected'. Leaving it
    // 'rejected' deadlocked the run when the re-run cascade reached it —
    // flipStepActiveGuarded requires 'pending'. The permanent audit of the
    // rejection lives in the chain.step_rejected row (asserted below) and in
    // the rejected review, which stays in the reviews table.
    expect(byN[2].status).toBe("pending");
    expect(byN[2].review_id).toBeNull();
    expect(byN[0].status).toBe("active"); // step 1 re-materialised
    expect(byN[0].review_id).not.toBe(originalStep1ReviewId); // new review, not the approved one
    expect(byN[1].status).toBe("pending"); // step 2 reset so the cascade re-executes it
    expect(byN[1].review_id).toBeNull();

    const stepRejected = stepRejectedEvents(deliveries);
    expect(stepRejected).toHaveLength(1);
    expect(stepRejected[0].body).toMatchObject({
      applied_policy: "branch",
      step_index: 3,
      next_step_index: 1,
    });

    // A1: chain.step_rejected audit row carries branch policy + branch_target
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "chain.step_rejected"),
        eq(auditLog.resource_id, result.chain_run_id),
      ));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actor).toBe("carol");
    expect(auditRows[0].resource_type).toBe("chain_run");
    expect(auditRows[0].details).toMatchObject({
      rejecting_step_number: 3,
      applied_step_policy: "branch",
      branch_target: 1,
    });
    expect(typeof (auditRows[0].details as Record<string, unknown>).rejected_at).toBe("string");
    expect(typeof (auditRows[0].details as Record<string, unknown>).rejecting_step_id).toBe("string");
  });

  // The existing branch tests all stop one assertion short: they check the
  // state immediately after the branch fires and never approve the
  // re-materialised steps. That is exactly where the run used to deadlock.
  //
  // Before the lte() fix in chain-rejection.ts, this sequence left the run
  // active with NO active step: step 3 was still 'rejected', so
  // flipStepActiveGuarded refused to activate it, the orphaned review was
  // closed, and reconcileImpl could never see the run because it only scans
  // runs that already have an active step. Silent and permanent.
  it("branch policy: the chain can be driven all the way back past the rejecting step", async () => {
    const deliveries: DeliveryLog = [];
    const { engine } = await makeEngine(db, deliveries);

    const result = await engine.createRun({
      definition: threeStepDef(slugs, [
        {},
        {},
        { rejection_policy: "branch", rejection_branch_to: 1 },
      ]),
      initial_payload: { content: "round trip" },
      callback_url: callbackUrl,
      project_id: projectId,
      created_by: "agent:test",
    });

    const stepsNow = async () => {
      const rows = await db.select().from(chainSteps)
        .where(eq(chainSteps.chain_run_id, result.chain_run_id));
      return rows.sort((a: any, b: any) => a.step_number - b.step_number);
    };
    const approveStep = async (n: number, actor: string) => {
      const s = (await stepsNow())[n - 1];
      await decide(db, s.review_id!, "approved", actor);
      await fireDecided(engine, s.review_id!, slugs[n - 1], projectId);
    };

    // First lap: approve 1 and 2, then reject 3 → branches back to step 1.
    await approveStep(1, "alice");
    await approveStep(2, "bob");
    const step3First = (await stepsNow())[2];
    await decide(db, step3First.review_id!, "rejected", "carol", "start over");
    await fireDecided(engine, step3First.review_id!, slugs[2], projectId);

    expect((await stepsNow())[0].status).toBe("active"); // back at step 1

    // Second lap: this is the part that used to deadlock.
    await approveStep(1, "alice");
    expect((await stepsNow())[1].status).toBe("active"); // step 2 re-materialised

    await approveStep(2, "bob");
    const after = await stepsNow();

    // Step 3 MUST come back to life. Before the fix it stayed 'rejected'
    // forever and the run silently stalled here.
    expect(after[2].status).toBe("active");
    expect(after[2].review_id).not.toBeNull();
    expect(after[2].review_id).not.toBe(step3First.review_id);

    // And the run must not be stranded: still active, with an active step.
    const [run] = await db.select().from(chainRuns)
      .where(eq(chainRuns.id, result.chain_run_id));
    expect(run.status).toBe("active");
    expect(after.filter((s: any) => s.status === "active")).toHaveLength(1);

    // Approving the re-run step 3 completes the chain rather than stalling.
    await approveStep(3, "carol");
    const [finished] = await db.select().from(chainRuns)
      .where(eq(chainRuns.id, result.chain_run_id));
    expect(finished.status).toBe("completed");
  });

  it("regression: abort path still emits chain.rejected audit (not chain.step_rejected)", async () => {
    // The abort path's chain.rejected audit shape is the M10 contract — the
    // A1 chain.step_rejected addition is for continue/branch only. Confirm
    // the abort path emits ONLY chain.rejected at the audit layer (the
    // chain.step_rejected webhook still fires from fireStepRejected, but no
    // audit row carries that action for abort).
    const deliveries: DeliveryLog = [];
    const { engine } = await makeEngine(db, deliveries);

    const result = await engine.createRun({
      definition: threeStepDef(slugs, [
        { rejection_policy: "abort" },
        {},
        {},
      ]),
      initial_payload: { content: "x" },
      callback_url: callbackUrl,
      project_id: projectId,
      created_by: "agent:test",
    });

    await decide(db, result.step_1_review_id, "rejected", "alice", "stop");
    await fireDecided(engine, result.step_1_review_id, slugs[0], projectId);

    const rejectedAudit = await db
      .select()
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "chain.rejected"),
        eq(auditLog.resource_id, result.chain_run_id),
      ));
    expect(rejectedAudit).toHaveLength(1);
    expect(rejectedAudit[0].details).toMatchObject({
      rejecting_step_number: 1,
      applied_step_policy: "abort",
    });

    // Abort path must NOT emit chain.step_rejected at audit layer
    const stepRejectedAudit = await db
      .select()
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "chain.step_rejected"),
        eq(auditLog.resource_id, result.chain_run_id),
      ));
    expect(stepRejectedAudit).toHaveLength(0);
  });
});

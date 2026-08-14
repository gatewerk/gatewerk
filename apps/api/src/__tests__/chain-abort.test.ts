import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "crypto";
import {
  chainRuns,
  chainSteps,
  reviews,
  templates,
  webhookDeliveries,
  projects,
  apiKeys,
  auditLog,
} from "@gatewerk/db/src/schema/index";
import { generateId, ALL_SCOPES, type ChainDefinition } from "@gatewerk/shared";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { createApp } from "../app";
import { ChainEngine } from "../services/chain-engine";
import { EventBus } from "../services/events";
import { WebhookService } from "../services/webhooks";
import { createAuditService } from "../services/audit";
import { applyStepRejection } from "../services/chain-rejection";

// Chain abort endpoint tests.
// POST /api/v1/chain-runs/:id/abort
//   — atomically marks chain_runs.status='aborted' and all pending/active
//     steps as 'skipped' when the run is currently active.
//   — 404 when the run doesn't exist.
//   — 409 (chain_run_not_active) when the run is already in a terminal state.

interface Captured {
  url: string;
  body: any;
  headers: Record<string, string>;
  event: string;
}

function createCapturingEngine(db: any) {
  const captured: Captured[] = [];
  const webhooks = new WebhookService({
    db,
    fetch: async (url: any, init: any) => {
      const headers = Object.fromEntries(
        Object.entries((init.headers || {}) as Record<string, string>),
      );
      captured.push({
        url: String(url),
        body: JSON.parse(init.body as string),
        headers,
        event: headers["X-Webhook-Event"] || "",
      });
      return new Response("", { status: 204 }) as any;
    },
  });
  const eventBus = new EventBus();
  const auditService = createAuditService(db);
  const engine = new ChainEngine({ db, webhooks, eventBus, auditService });
  engine.subscribe(eventBus);
  return { engine, webhooks, captured, auditService, eventBus };
}

async function seedTemplates(db: any, projectId: string) {
  const slugs = ["abort_tpl_1", "abort_tpl_2"];
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

function twoStep(slugs: string[]): ChainDefinition {
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
  await new Promise((r) => setTimeout(r, 50));
}

// Seed a second project + API key (auth resolves by sha256 key_hash, so a
// distinct raw key suffices to scope a caller to a different project).
async function seedSecondProject(db: any) {
  const rawKey = "gwk_projB234567890abcdef";
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const [project] = await db
    .insert(projects)
    .values({
      id: generateId("project"),
      name: "Test Project B",
      hmac_secret: "test-hmac-secret-b",
    })
    .returning();
  await db.insert(apiKeys).values({
    id: generateId("api_key"),
    project_id: project.id,
    key_hash: keyHash,
    key_prefix: "gwk_projB",
    label: "Test key B",
    scopes: [...ALL_SCOPES],
  });
  return { project, apiKey: rawKey };
}

describe("Chain abort endpoint", () => {
  let app: any;
  let db: any;
  let apiKey: string;
  let projectId: string;
  let slugs: string[];
  let captured: Captured[];
  let apiKeyB: string;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;
    slugs = await seedTemplates(db, projectId);

    const seedB = await seedSecondProject(db);
    apiKeyB = seedB.apiKey;

    captured = [];
    app = createApp({ db });
  });

  beforeEach(async () => {
    captured.length = 0;
    await db.delete(webhookDeliveries);
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  async function createRun() {
    const res = await request(app)
      .post("/api/v1/chain-runs")
      .set(auth())
      .send({ definition: twoStep(slugs), initial_payload: { content: "test" } });
    expect(res.status).toBe(201);
    return res.body;
  }

  // ABORT-1: happy path — active run returns 200 { status: "aborted" }
  it("ABORT-1: POST /chain-runs/:id/abort returns 200 { status=aborted } for an active run", async () => {
    const run = await createRun();
    const res = await request(app)
      .post(`/api/v1/chain-runs/${run.id}/abort`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("aborted");
    expect(typeof res.body.skipped).toBe("number");
  });

  // ABORT-6: no auth header → 401
  it("ABORT-6: POST /chain-runs/:id/abort without auth returns 401", async () => {
    const run = await createRun();
    const res = await request(app)
      .post(`/api/v1/chain-runs/${run.id}/abort`);
    expect(res.status).toBe(401);
  });

  // ABORT-3: pending/active steps become skipped
  it("ABORT-3: all pending and active steps become skipped after abort", async () => {
    const run = await createRun();
    await request(app).post(`/api/v1/chain-runs/${run.id}/abort`).set(auth());

    const steps = await db
      .select()
      .from(chainSteps)
      .where(eq(chainSteps.chain_run_id, run.id));
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) {
      expect(s.status).toBe("skipped");
    }
  });

  // ABORT-4: second abort → 409 chain_run_not_active (idempotency via atomic WHERE)
  it("ABORT-4: second abort on same run returns 409 chain_run_not_active", async () => {
    const run = await createRun();
    await request(app).post(`/api/v1/chain-runs/${run.id}/abort`).set(auth());
    const res = await request(app)
      .post(`/api/v1/chain-runs/${run.id}/abort`)
      .set(auth());
    expect(res.status).toBe(409);
    expect(res.body?.error?.code).toBe("chain_run_not_active");
  });

  // ABORT-2: DB row reflects aborted status
  it("ABORT-2: chain_runs.status is aborted in DB after abort", async () => {
    const run = await createRun();
    await request(app).post(`/api/v1/chain-runs/${run.id}/abort`).set(auth());

    const [dbRun] = await db
      .select()
      .from(chainRuns)
      .where(eq(chainRuns.id, run.id));
    expect(dbRun.status).toBe("aborted");
    expect(dbRun.completed_at).toBeTruthy();
  });

  // ABORT-7: GET /chain-runs/:id reflects aborted status
  it("ABORT-7: GET /chain-runs/:id reflects aborted status after abort", async () => {
    const run = await createRun();
    await request(app).post(`/api/v1/chain-runs/${run.id}/abort`).set(auth());

    const res = await request(app)
      .get(`/api/v1/chain-runs/${run.id}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("aborted");
  });

  // ABORT-9: abort a non-existent run → 404
  it("ABORT-9: aborting a non-existent run returns 404", async () => {
    const res = await request(app)
      .post("/api/v1/chain-runs/gw_chain_does-not-exist/abort")
      .set(auth());
    expect(res.status).toBe(404);
  });

  // ABORT-10 (Defect 1): a run owned by project A, aborted by a project-B
  // caller, must return 404 (NOT 409). 409 would leak that the id exists.
  it("ABORT-10: cross-project abort returns 404, not 409 (no existence leak)", async () => {
    const run = await createRun(); // created under project A (apiKey)
    const res = await request(app)
      .post(`/api/v1/chain-runs/${run.id}/abort`)
      .set({ Authorization: `Bearer ${apiKeyB}` }); // project B caller
    expect(res.status).toBe(404);
    // Must not surface the not-active conflict code (that would imply the id exists).
    expect(res.body?.error?.code).not.toBe("chain_run_not_active");

    // And the run is untouched — still active in project A.
    const [dbRun] = await db
      .select()
      .from(chainRuns)
      .where(eq(chainRuns.id, run.id));
    expect(dbRun.status).toBe("active");
  });
});

// ABORT-8 (webhook): service-level test for sendChainAborted payload.
// Uses a capturing engine (mirrors chain-webhooks.test.ts pattern) so we
// can spy on webhook emissions without HTTP overhead.
describe("Chain abort webhook (ABORT-8)", () => {
  let db: any;
  let projectId: string;
  let slugs: string[];
  let captured: Captured[];
  let engine: ChainEngine;
  let webhooks: WebhookService;
  let auditService: ReturnType<typeof createAuditService>;
  let eventBus: EventBus;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    slugs = await seedTemplates(db, projectId);
    const e = createCapturingEngine(db);
    engine = e.engine;
    captured = e.captured;
    webhooks = e.webhooks;
    auditService = e.auditService;
    eventBus = e.eventBus;

    // Give the project an hmac_secret so the abort webhook fires.
    const { projects } = await import("@gatewerk/db/src/schema/index");
    await db
      .update(projects)
      .set({ hmac_secret: "test-hmac-abort" })
      .where(eq(projects.id, projectId));
  });

  beforeEach(async () => {
    captured.length = 0;
    await db.delete(webhookDeliveries);
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
  });

  it("ABORT-8: abortRun fires chain.aborted webhook with correct payload", async () => {
    const runResult = await engine.createRun({
      definition: twoStep(slugs),
      initial_payload: { content: "webhook-test" },
      callback_url: "https://example.com/hook",
      project_id: projectId,
      created_by: "agent:test",
    });

    const result = await engine.abortRun(runResult.chain_run_id, projectId, "agent:test");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("aborted");

    await flushAsync();

    const chainAbortedEvents = captured.filter((c) => c.event === "chain.aborted");
    expect(chainAbortedEvents.length).toBeGreaterThan(0);
    const payload = chainAbortedEvents[0].body;
    expect(payload.type).toBe("chain.aborted");
    expect(payload.chain_run_id).toBe(runResult.chain_run_id);
    expect(payload.status).toBe("aborted");
    expect(typeof payload.skipped_step_count).toBe("number");
    expect(payload.aborted_by).toBeTruthy();
  });

  it("ABORT-8b: no webhook fires when no step has been materialized (no review_id)", async () => {
    // A run where no steps have been materialized has no anchor review →
    // webhook is skipped entirely.  We simulate this by directly inserting a
    // chain_run (+ steps with review_id=null) without going through the engine.
    const { generateId: genId } = await import("@gatewerk/shared");
    const runId = genId("chain_run");
    await db.insert(chainRuns).values({
      id: runId,
      project_id: projectId,
      name: null,
      mode: "sequential",
      rejection_policy: "terminate",
      status: "active",
      created_by: "agent:test",
      created_at: new Date(),
    });
    // Insert one pending step with no review_id
    const { chainSteps: cs } = await import("@gatewerk/db/src/schema/index");
    await db.insert(cs).values({
      id: genId("chain_step"),
      chain_run_id: runId,
      step_number: 1,
      review_id: null,
      assignee_spec: { template: "t", assignee: { kind: "user", email: "x@y.com" } },
      status: "pending",
    });

    const result = await engine.abortRun(runId, projectId, "agent:test");
    expect(result?.status).toBe("aborted");

    await flushAsync();

    const chainAbortedEvents = captured.filter((c) => c.event === "chain.aborted");
    expect(chainAbortedEvents.length).toBe(0);
  });

  // ABORT-8c (Defect 2): a run with step 1 approved + step 2 active (two
  // distinct materialized review_ids). The abort webhook MUST anchor on the
  // in-flight (active) step 2 review, NOT the first/lowest-numbered step 1.
  it("ABORT-8c: abort anchors webhook on the active step's review, not the first", async () => {
    const runResult = await engine.createRun({
      definition: twoStep(slugs),
      initial_payload: { content: "anchor-test" },
      callback_url: "https://example.com/hook",
      project_id: projectId,
      created_by: "agent:test",
    });
    const step1ReviewId = runResult.step_1_review_id;

    // Approve step 1 → engine materializes step 2 (status='active') with a
    // distinct review_id.
    await db
      .update(reviews)
      .set({
        status: "decided",
        decision: "approved",
        decided_by: "alice",
        decided_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(reviews.id, step1ReviewId));
    await engine.onReviewDecided({
      review_id: step1ReviewId,
      template: slugs[0],
      project_id: projectId,
      priority: "normal",
      created_at: new Date().toISOString(),
    } as any);
    await flushAsync();

    // Resolve step 2's review_id (the active, in-flight step).
    const [step2] = await db
      .select({ review_id: chainSteps.review_id })
      .from(chainSteps)
      .where(and(eq(chainSteps.chain_run_id, runResult.chain_run_id), eq(chainSteps.step_number, 2)));
    const step2ReviewId = step2.review_id as string;
    expect(step2ReviewId).toBeTruthy();
    expect(step2ReviewId).not.toBe(step1ReviewId);

    // Clear prior captures (next_step_ready etc.) so we isolate the abort send.
    captured.length = 0;

    const result = await engine.abortRun(runResult.chain_run_id, projectId, "agent:test");
    expect(result?.status).toBe("aborted");
    await flushAsync();

    // The chain.aborted webhook fired.
    const chainAbortedEvents = captured.filter((c) => c.event === "chain.aborted");
    expect(chainAbortedEvents.length).toBe(1);

    // The delivery row is anchored on step 2's review_id (the active one),
    // NOT step 1's. The anchor is the webhook_deliveries.review_id FK.
    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.event_type, "chain.aborted"));
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].review_id).toBe(step2ReviewId);
    expect(deliveries[0].review_id).not.toBe(step1ReviewId);
  });

  // ABORT-CANCEL (FIX C): abort closes the operator's open in-flight review so
  // an aborted run leaves nothing sitting in the inbox.
  it("ABORT-CANCEL: abort cancels the open in-flight review (status -> expired)", async () => {
    const runResult = await engine.createRun({
      definition: twoStep(slugs),
      initial_payload: { content: "cancel-test" },
      callback_url: "https://example.com/hook",
      project_id: projectId,
      created_by: "agent:test",
    });

    const [before] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, runResult.step_1_review_id));
    expect(before.status).toBe("pending"); // open, awaiting the operator

    const result = await engine.abortRun(runResult.chain_run_id, projectId, "agent:test");
    expect(result?.status).toBe("aborted");

    const [after] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, runResult.step_1_review_id));
    expect(after.status).toBe("expired"); // closed without a decision
  });

  // ADVANCE-RECHECK (FIX A): an in-flight onReviewDecided that interleaves with
  // a concurrent abort must NOT advance the chain. We simulate the race by
  // flipping the run to 'aborted' directly in the DB, then invoking
  // handleApprove with a STALE run object that still shows 'active'. Step 2 is
  // left 'pending' (not skipped) so this isolates FIX A: the materializeStep
  // guard (FIX B, which requires status='pending') would NOT catch a pending
  // step — only the run-status recheck prevents materialisation here.
  it("ADVANCE-RECHECK: handleApprove bails when the run was concurrently aborted", async () => {
    const runResult = await engine.createRun({
      definition: twoStep(slugs),
      initial_payload: { content: "race-test" },
      callback_url: "https://example.com/hook",
      project_id: projectId,
      created_by: "agent:test",
    });

    // Snapshot the run row WHILE it is still active — this is the stale object
    // an in-flight onReviewDecided would be holding.
    const [staleActiveRun] = await db
      .select()
      .from(chainRuns)
      .where(eq(chainRuns.id, runResult.chain_run_id));
    expect(staleActiveRun.status).toBe("active");

    const [step1Row] = await db
      .select()
      .from(chainSteps)
      .where(and(eq(chainSteps.chain_run_id, runResult.chain_run_id), eq(chainSteps.step_number, 1)));
    const [review1] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, runResult.step_1_review_id));

    // The human decided step 1 (legit), then a concurrent abort flips the run
    // to 'aborted' directly in the DB — AFTER onReviewDecided read it active.
    await db
      .update(chainSteps)
      .set({ status: "approved" })
      .where(eq(chainSteps.id, step1Row.id));
    await db
      .update(reviews)
      .set({ status: "decided", decision: "approved", decided_by: "alice", decided_at: new Date() })
      .where(eq(reviews.id, review1.id));
    await db
      .update(chainRuns)
      .set({ status: "aborted", completed_at: new Date() })
      .where(eq(chainRuns.id, runResult.chain_run_id));

    const reviewsBefore = await db
      .select()
      .from(reviews)
      .where(eq(reviews.chain_run_id, runResult.chain_run_id));

    // Stale advance: pass the run object that still shows 'active'.
    await (engine as any).handleApprove(staleActiveRun, step1Row, {
      ...review1,
      status: "decided",
      decision: "approved",
    });
    await flushAsync();

    // Step 2 must NOT have materialised: no new review row, step 2 still
    // 'pending' with a null review_id.
    const reviewsAfter = await db
      .select()
      .from(reviews)
      .where(eq(reviews.chain_run_id, runResult.chain_run_id));
    expect(reviewsAfter.length).toBe(reviewsBefore.length);

    const [step2After] = await db
      .select()
      .from(chainSteps)
      .where(and(eq(chainSteps.chain_run_id, runResult.chain_run_id), eq(chainSteps.step_number, 2)));
    expect(step2After.status).toBe("pending");
    expect(step2After.status).not.toBe("active");
    expect(step2After.review_id).toBeNull();
  });

  // BRANCH-RACE (EXISTS backstop): the branch path defeats a status-only flip
  // guard — branchToStep resets the target approved->pending AFTER abort's
  // step-skip (which only touches pending/active) passed over the approved
  // target. The materializeStep flip would then MATCH on status='pending' and
  // re-activate the target under an aborted run. The EXISTS(run still active)
  // clause closes this atomically: the flip can only succeed while the run is
  // active at the instant of the UPDATE. We reproduce the exact racy DB state
  // (target reset to pending, run already aborted) and drive the branch
  // re-materialise — asserting no orphan active step/review results.
  it("BRANCH-RACE: branch re-materialise under a concurrently-aborted run does not orphan", async () => {
    const def: ChainDefinition = {
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        { id: "s1", template: slugs[0], assignee: { kind: "user", email: "alice@x.com" } },
        {
          id: "s2",
          template: slugs[1],
          assignee: { kind: "user", email: "bob@x.com" },
          rejection_policy: "branch",
          rejection_branch_to: 1,
        },
      ],
    };
    const runResult = await engine.createRun({
      definition: def,
      initial_payload: { content: "x" },
      callback_url: "https://example.com/hook",
      project_id: projectId,
      created_by: "agent:test",
    });

    // Approve step 1 → step 2 materialises active; step 1 becomes 'approved'.
    await db
      .update(reviews)
      .set({ status: "decided", decision: "approved", decided_by: "alice", decided_at: new Date(), updated_at: new Date() })
      .where(eq(reviews.id, runResult.step_1_review_id));
    await engine.onReviewDecided({
      review_id: runResult.step_1_review_id,
      template: slugs[0],
      project_id: projectId,
      priority: "normal",
      created_at: new Date().toISOString(),
    } as any);
    await flushAsync();

    const [step1Row] = await db
      .select()
      .from(chainSteps)
      .where(and(eq(chainSteps.chain_run_id, runResult.chain_run_id), eq(chainSteps.step_number, 1)));
    expect(step1Row.status).toBe("approved"); // target already passed

    // Concurrent abort: run aborted; the skip touches only pending/active, so
    // the 'approved' target (step 1) is passed over (stays approved); step 2
    // active -> skipped.
    await db
      .update(chainRuns)
      .set({ status: "aborted", completed_at: new Date() })
      .where(eq(chainRuns.id, runResult.chain_run_id));
    await db
      .update(chainSteps)
      .set({ status: "skipped" })
      .where(and(eq(chainSteps.chain_run_id, runResult.chain_run_id), inArray(chainSteps.status, ["pending", "active"])));

    // branchToStep then resets the target approved -> pending (the exact state
    // that defeats a status-only guard).
    await db
      .update(chainSteps)
      .set({ status: "pending", review_id: null, materialized_at: null })
      .where(eq(chainSteps.id, step1Row.id));

    // Drive the branch re-materialise (what branchToStep hands to
    // materializeStep). The EXISTS backstop makes the flip miss (run aborted)
    // and closes the freshly-inserted review to 'expired'.
    const createdReview = await (engine as any).materializeStep({
      chainRunId: runResult.chain_run_id,
      stepRowId: step1Row.id,
      stepNumber: 1,
      stepDefinition: step1Row.assignee_spec,
      payload: { content: "x" },
      // C1: materializeStep resolves the route's entry template, passed in by
      // the caller rather than read off the step.
      entryTemplateSlug: (step1Row.assignee_spec as any).template,
      prevReviewId: null,
      callbackUrl: "https://example.com/hook",
      projectId,
      fireNextStepWebhook: true,
    });
    await flushAsync();

    // Target must NOT be active and must NOT link the new review.
    const [step1After] = await db.select().from(chainSteps).where(eq(chainSteps.id, step1Row.id));
    expect(step1After.status).not.toBe("active");
    expect(step1After.review_id).toBeNull();

    // The freshly-inserted review is closed (expired), not left open/orphaned.
    const [createdAfter] = await db.select().from(reviews).where(eq(reviews.id, createdReview.id));
    expect(createdAfter.status).toBe("expired");

    // No step anywhere in the aborted run is 'active'.
    const allSteps = await db
      .select()
      .from(chainSteps)
      .where(eq(chainSteps.chain_run_id, runResult.chain_run_id));
    expect(allSteps.some((s: any) => s.status === "active")).toBe(false);
  });

  // ABORT-COMPLETE-RACE: completeRun's terminal write must not overwrite a
  // concurrently-committed abort. We simulate the stale-recheck race by setting
  // the run to 'aborted' in the DB, then driving completeRun with a run object
  // that still shows 'active'. The guarded UPDATE (WHERE status='active') misses
  // → abort wins, and NO chain.completed audit/webhook fires.
  it("ABORT-COMPLETE-RACE: completeRun bails when run was concurrently aborted (abort wins)", async () => {
    const runResult = await engine.createRun({
      definition: twoStep(slugs),
      initial_payload: { content: "x" },
      callback_url: "https://example.com/hook",
      project_id: projectId,
      created_by: "agent:test",
    });

    const [staleActiveRun] = await db
      .select()
      .from(chainRuns)
      .where(eq(chainRuns.id, runResult.chain_run_id));
    expect(staleActiveRun.status).toBe("active");

    const [finalReview] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, runResult.step_1_review_id));

    // The human approved the final step (legit), then a concurrent abort commits.
    await db
      .update(reviews)
      .set({ status: "decided", decision: "approved", decided_by: "alice", decided_at: new Date() })
      .where(eq(reviews.id, finalReview.id));
    await db
      .update(chainRuns)
      .set({ status: "aborted", completed_at: new Date() })
      .where(eq(chainRuns.id, runResult.chain_run_id));

    captured.length = 0;
    // Stale completeRun: pass the run object that still shows 'active'.
    await (engine as any).completeRun(staleActiveRun, {
      ...finalReview,
      status: "decided",
      decision: "approved",
    });
    await flushAsync();

    const [runAfter] = await db
      .select()
      .from(chainRuns)
      .where(eq(chainRuns.id, runResult.chain_run_id));
    expect(runAfter.status).toBe("aborted"); // NOT overwritten to 'completed'

    const completedAudit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "chain.completed"), eq(auditLog.resource_id, runResult.chain_run_id)));
    expect(completedAudit.length).toBe(0);
    expect(captured.filter((c) => c.event === "chain.completed").length).toBe(0);
  });

  // ABORT-REJECT-RACE: abortChain's terminal write must not overwrite a
  // concurrently-committed abort. We drive the abort-policy reject path
  // (applyStepRejection, which for the abort policy calls abortChain with no
  // recheck of its own) with the run already 'aborted' and a stale-active run
  // object — simulating abort committing after applyStepRejection's recheck.
  // The guarded UPDATE misses → abort wins, no chain.rejected terminal event.
  it("ABORT-REJECT-RACE: abortChain bails when run was concurrently aborted (abort wins)", async () => {
    const runResult = await engine.createRun({
      definition: twoStep(slugs),
      initial_payload: { content: "x" },
      callback_url: "https://example.com/hook",
      project_id: projectId,
      created_by: "agent:test",
    });

    const [staleActiveRun] = await db
      .select()
      .from(chainRuns)
      .where(eq(chainRuns.id, runResult.chain_run_id));
    const [step1Row] = await db
      .select()
      .from(chainSteps)
      .where(and(eq(chainSteps.chain_run_id, runResult.chain_run_id), eq(chainSteps.step_number, 1)));
    const [review1] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, runResult.step_1_review_id));

    // The human rejected step 1 (legit), then a concurrent abort commits.
    await db
      .update(reviews)
      .set({ status: "decided", decision: "rejected", decided_by: "alice", decided_at: new Date(), feedback: "no" })
      .where(eq(reviews.id, review1.id));
    await db.update(chainSteps).set({ status: "rejected" }).where(eq(chainSteps.id, step1Row.id));
    await db
      .update(chainRuns)
      .set({ status: "aborted", completed_at: new Date() })
      .where(eq(chainRuns.id, runResult.chain_run_id));

    captured.length = 0;
    // Drive the abort-policy reject path directly (recheck simulated as stale).
    const deps = {
      db,
      webhooks,
      auditService,
      materializeStep: (args: any) => (engine as any).materializeStep(args),
      buildTranscript: (id: string) => (engine as any).buildTranscript(id),
      getHmacSecret: (id: string) => (engine as any).getHmacSecret(id),
      reconstructStepDefinition: (s: any) => (engine as any).reconstructStepDefinition(s),
      completeRun: (r: any, review: any) => (engine as any).completeRun(r, review),
    };
    await applyStepRejection(
      deps as any,
      staleActiveRun,
      { ...step1Row, status: "rejected", rejection_policy: "abort" } as any,
      { ...review1, status: "decided", decision: "rejected", feedback: "no" } as any,
    );
    await flushAsync();

    const [runAfter] = await db
      .select()
      .from(chainRuns)
      .where(eq(chainRuns.id, runResult.chain_run_id));
    expect(runAfter.status).toBe("aborted"); // NOT overwritten to 'rejected'

    const rejectedAudit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "chain.rejected"), eq(auditLog.resource_id, runResult.chain_run_id)));
    expect(rejectedAudit.length).toBe(0);
    expect(captured.filter((c) => c.event === "chain.rejected").length).toBe(0);
  });

  // REJECT-OWNER-TAP: closes a review gap. All other tests in this file drive
  // rejection with created_by="agent:test", so chainOwnerEmail always returns
  // undefined and the eventBus.emit("chain.rejected", ...) branch in
  // chain-rejection.ts's abortChain() never actually runs. That made the
  // ABORT-REJECT-RACE deps object's missing `eventBus` (papered over with
  // `deps as any`) safe only by accident. This drives the abort-policy reject
  // path (the default policy — no rejection_policy on either step of
  // twoStep()) through the real engine + a real EventBus, spied rather than
  // cast away.
  it("REJECT-OWNER-TAP: rejecting a step in a reviewer-started chain emits chain.rejected tapping the owner", async () => {
    const runResult = await engine.createRun({
      definition: twoStep(slugs),
      initial_payload: { content: "owner-tap-test" },
      project_id: projectId,
      created_by: "reviewer:owner@example.com",
    });

    await db
      .update(reviews)
      .set({
        status: "decided",
        decision: "rejected",
        decided_by: "someone_else",
        decided_at: new Date(),
        updated_at: new Date(),
        feedback: "no good",
      })
      .where(eq(reviews.id, runResult.step_1_review_id));

    const emitSpy = vi.spyOn(eventBus, "emit");
    await engine.onReviewDecided({
      review_id: runResult.step_1_review_id,
      template: slugs[0],
      project_id: projectId,
      priority: "normal",
      created_at: new Date().toISOString(),
    } as any);
    await flushAsync();

    expect(emitSpy).toHaveBeenCalledWith(
      "chain.rejected",
      expect.objectContaining({
        notify_assignee: "owner@example.com",
        review_id: runResult.step_1_review_id,
      }),
    );

    const [runAfter] = await db
      .select()
      .from(chainRuns)
      .where(eq(chainRuns.id, runResult.chain_run_id));
    expect(runAfter.status).toBe("rejected");

    emitSpy.mockRestore();
  });

  it("REJECT-OWNER-TAP-AGENT: an agent-started chain emits chain.rejected with nobody to tap", async () => {
    const runResult = await engine.createRun({
      definition: twoStep(slugs),
      initial_payload: { content: "owner-tap-agent-test" },
      project_id: projectId,
      created_by: "agent:test",
    });

    await db
      .update(reviews)
      .set({
        status: "decided",
        decision: "rejected",
        decided_by: "someone_else",
        decided_at: new Date(),
        updated_at: new Date(),
        feedback: "no good",
      })
      .where(eq(reviews.id, runResult.step_1_review_id));

    const emitSpy = vi.spyOn(eventBus, "emit");
    await engine.onReviewDecided({
      review_id: runResult.step_1_review_id,
      template: slugs[0],
      project_id: projectId,
      priority: "normal",
      created_at: new Date().toISOString(),
    } as any);
    await flushAsync();

    // C1 §5.1 inverted this, for the same reason completeRun's emit was
    // ungated. The bus is the SSE channel and the channel the SDK wait helpers
    // use to learn a route terminated; gating it on a human owner left
    // agent-started runs — the ones an agent is actually waiting on — with no
    // terminal signal at all.
    //
    // What stays owner-dependent is the NOTIFICATION target. There is no human
    // to tap here, so notify_assignee is absent, and PersonalNotifier drops a
    // chain terminal event that has none rather than falling back to the
    // review's assignee, who on a rejected step is the reviewer who just
    // rejected it.
    expect(emitSpy).toHaveBeenCalledWith("chain.rejected", expect.anything());
    const rejectedCall = emitSpy.mock.calls.find((c) => c[0] === "chain.rejected")!;
    expect(rejectedCall[1]).not.toHaveProperty("notify_assignee");

    const [runAfter] = await db
      .select()
      .from(chainRuns)
      .where(eq(chainRuns.id, runResult.chain_run_id));
    expect(runAfter.status).toBe("rejected");

    emitSpy.mockRestore();
  });
});

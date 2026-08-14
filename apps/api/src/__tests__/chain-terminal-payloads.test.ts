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
import { executeReviewAction } from "../services/reviews/execute-action";

// C1 (charter §5.1): chain.completed is now THE authorization signal for a
// chain, because review.decided is withheld for chain-attached reviews. That
// promotion has obligations. It has to name the reviews it is about, and it
// has to carry what was actually authorized: the engine forwards
// approved_value step to step, so the authorized object is routinely NOT the
// payload the agent submitted.

interface Captured {
  body: any;
  event: string;
}

describe("terminal chain payloads", () => {
  let db: any;
  let projectId: string;
  let engine: ChainEngine;
  let eventBus: EventBus;
  let webhooks: WebhookService;
  let captured: Captured[];
  let busEvents: string[];

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "route_tpl",
      project_id: projectId,
      name: "Route",
      fields: [{ name: "amount", type: "number", label: "Amount", editable: true }],
      actions: ["approve", "reject"],
    });
  });

  beforeEach(async () => {
    await db.delete(webhookDeliveries);
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
    captured = [];
    busEvents = [];
    webhooks = new WebhookService({
      db,
      fetch: async (_url: any, init: any) => {
        const headers = (init.headers || {}) as Record<string, string>;
        captured.push({ body: JSON.parse(init.body as string), event: headers["X-Webhook-Event"] || "" });
        return new Response("", { status: 204 }) as any;
      },
    });
    eventBus = new EventBus();
    for (const name of ["chain.completed", "chain.rejected"]) {
      eventBus.on(name as any, () => {
        busEvents.push(name);
      });
    }
    engine = new ChainEngine({ db, webhooks, eventBus });
    engine.subscribe(eventBus);
  });

  const route = (): ChainDefinition =>
    ({
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      template: "route_tpl",
      steps: [
        { id: "s1", assignee: { kind: "user", email: "junior@corp.co" } },
        { id: "s2", assignee: { kind: "user", email: "senior@corp.co" } },
      ],
    }) as ChainDefinition;

  async function decide(
    reviewId: string,
    actionId: string,
    by: string,
    editedPayload?: Record<string, unknown>,
  ) {
    await executeReviewAction({
      db, webhooks, eventBus, reviewId, projectId,
      actor: { type: "reviewer", id: by, email: by },
      triggerPath: "dashboard",
      actionId,
      editedPayload,
      feedback: actionId === "reject" ? "No" : undefined,
    } as any);
    await new Promise((r) => setTimeout(r, 60));
  }

  async function startRun(createdBy = "agent:test") {
    return engine.createRun({
      definition: route(),
      initial_payload: { amount: 100 },
      callback_url: "https://agent.example.com/cb",
      project_id: projectId,
      created_by: createdBy,
    });
  }

  async function stepTwoReviewId(chainRunId: string) {
    const steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, chainRunId));
    return steps.find((s: any) => s.step_number === 2)!.review_id as string;
  }

  it("chain.completed names both the first and the final review", async () => {
    const run = await startRun();
    await decide(run.step_1_review_id, "approve", "junior@corp.co");
    const s2 = await stepTwoReviewId(run.chain_run_id);
    await decide(s2, "approve", "senior@corp.co");

    const done = captured.find((c) => c.event === "chain.completed");
    expect(done).toBeDefined();
    expect(done!.body.final_review_id).toBe(s2);
    expect(done!.body.initial_review_id).toBe(run.step_1_review_id);
    expect(done!.body.final_decision).toBe("approved");
    expect(done!.body.decided_by).toBe("senior@corp.co");
    expect(done!.body.decided_at).toEqual(expect.any(String));
  });

  it("chain.completed carries what was AUTHORIZED, not what was submitted", async () => {
    const run = await startRun();
    // Step 1's reviewer edits the amount down. The engine forwards
    // approved_value to step 2, so the authorized object is not the agent's.
    await decide(run.step_1_review_id, "approve", "junior@corp.co", { amount: 90 });
    const s2 = await stepTwoReviewId(run.chain_run_id);
    await decide(s2, "approve", "senior@corp.co");

    const done = captured.find((c) => c.event === "chain.completed")!;
    expect(done.body.approved_value).toEqual({ amount: 90 });
    expect(done.body.was_edited).toBe(false); // step 2 approved as-is
  });

  it("chain.rejected names the run's first review", async () => {
    const run = await startRun();
    await decide(run.step_1_review_id, "reject", "junior@corp.co");

    const rejected = captured.find((c) => c.event === "chain.rejected");
    expect(rejected).toBeDefined();
    expect(rejected!.body.initial_review_id).toBe(run.step_1_review_id);
  });

  it("chain.aborted names the review it anchors to", async () => {
    const run = await startRun();
    await engine.abortRun(run.chain_run_id, projectId, "reviewer:admin@corp.co");
    await new Promise((r) => setTimeout(r, 60));

    const aborted = captured.find((c) => c.event === "chain.aborted");
    expect(aborted).toBeDefined();
    expect(aborted!.body.anchor_review_id).toBe(run.step_1_review_id);
    expect(aborted!.body.initial_review_id).toBe(run.step_1_review_id);
  });

  it("emits chain.completed on the internal bus for an AGENT-started chain", async () => {
    // The bus emit is the SSE and SDK channel. Gating it on a human owner
    // meant an agent-started chain never reached the very consumers that have
    // to stop waiting on a single step's decision.
    const run = await startRun("agent:gw_live_abc");
    await decide(run.step_1_review_id, "approve", "junior@corp.co");
    const s2 = await stepTwoReviewId(run.chain_run_id);
    await decide(s2, "approve", "senior@corp.co");

    expect(busEvents).toContain("chain.completed");
  });
});

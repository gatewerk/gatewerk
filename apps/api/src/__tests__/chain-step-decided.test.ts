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

// C1 (charter §5.1): chain.step_decided is what a chain step's decision looks
// like on the wire, now that review.decided is withheld for chain-attached
// reviews. These tests drive the REAL decision path (executeReviewAction), not
// a hand-written review UPDATE, because that is the path the event fires from.

interface Captured {
  body: any;
  event: string;
}

describe("chain.step_decided", () => {
  let db: any;
  let projectId: string;
  let engine: ChainEngine;
  let eventBus: EventBus;
  let webhooks: WebhookService;
  let captured: Captured[];

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
      fields: [{ name: "amount", type: "number", label: "Amount" }],
      actions: ["approve", "reject"],
    });
  });

  beforeEach(async () => {
    await db.delete(webhookDeliveries);
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
    captured = [];
    webhooks = new WebhookService({
      db,
      fetch: async (_url: any, init: any) => {
        const headers = (init.headers || {}) as Record<string, string>;
        captured.push({ body: JSON.parse(init.body as string), event: headers["X-Webhook-Event"] || "" });
        return new Response("", { status: 204 }) as any;
      },
    });
    eventBus = new EventBus();
    engine = new ChainEngine({ db, webhooks, eventBus });
    engine.subscribe(eventBus);
  });

  const twoStepRoute = (): ChainDefinition =>
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

  async function decide(reviewId: string, actionId: string, by: string) {
    await executeReviewAction({
      db,
      webhooks,
      eventBus,
      reviewId,
      projectId,
      actor: { type: "reviewer", id: by, email: by },
      triggerPath: "dashboard",
      actionId,
      // The reject preset requires feedback; harmless on approve.
      feedback: actionId === "reject" ? "Numbers do not add up" : undefined,
    } as any);
    await new Promise((r) => setTimeout(r, 60));
  }

  async function startRun() {
    return engine.createRun({
      definition: twoStepRoute(),
      initial_payload: { amount: 100 },
      callback_url: "https://agent.example.com/cb",
      project_id: projectId,
      created_by: "agent:test",
    });
  }

  it("fires on an intermediate approval, carrying the step position and decider", async () => {
    const run = await startRun();
    await decide(run.step_1_review_id, "approve", "junior@corp.co");

    const hook = captured.find((c) => c.event === "chain.step_decided");
    expect(hook).toBeDefined();
    expect(hook!.body.type).toBe("chain.step_decided");
    expect(hook!.body.chain_run_id).toBe(run.chain_run_id);
    expect(hook!.body.step_index).toBe(1);
    expect(hook!.body.review_id).toBe(run.step_1_review_id);
    expect(hook!.body.decision).toBe("approved");
    expect(hook!.body.decided_by).toBe("junior@corp.co");
  });

  it("never sends review.decided for a chain step", async () => {
    const run = await startRun();
    await decide(run.step_1_review_id, "approve", "junior@corp.co");

    expect(captured.find((c) => c.event === "review.decided")).toBeUndefined();
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.event_type, "review.decided"));
    // Recorded, so an operator can see what was withheld, but not delivered.
    expect(rows.every((r: any) => r.status === "suppressed")).toBe(true);
  });

  it("fires on the FINAL approval, where chain.next_step_ready provably does not", async () => {
    const run = await startRun();
    await decide(run.step_1_review_id, "approve", "junior@corp.co");
    const steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, run.chain_run_id));
    const step2 = steps.find((s: any) => s.step_number === 2)!;
    captured.length = 0;

    await decide(step2.review_id!, "approve", "senior@corp.co");

    const decided = captured.filter((c) => c.event === "chain.step_decided");
    expect(decided).toHaveLength(1);
    expect(decided[0].body.step_index).toBe(2);
    // The final step materialises nothing, so the advance event is absent.
    expect(captured.find((c) => c.event === "chain.next_step_ready")).toBeUndefined();
    expect(captured.find((c) => c.event === "chain.completed")).toBeDefined();
  });

  it("fires on a rejection, carrying the verdict", async () => {
    const run = await startRun();
    await decide(run.step_1_review_id, "reject", "junior@corp.co");

    const hook = captured.find((c) => c.event === "chain.step_decided");
    expect(hook).toBeDefined();
    expect(hook!.body.decision).toBe("rejected");
    expect(hook!.body.step_index).toBe(1);
    expect(hook!.body.feedback).toBe("Numbers do not add up");
  });

  it("claims no finality: no is_final, no total_steps, no countdown to read", async () => {
    const run = await startRun();
    await decide(run.step_1_review_id, "approve", "junior@corp.co");

    const hook = captured.find((c) => c.event === "chain.step_decided")!;
    expect(hook.body).not.toHaveProperty("is_final");
    expect(hook.body).not.toHaveProperty("total_steps");
    expect(hook.body).not.toHaveProperty("steps_remaining");
  });

  it("still fires when the engine then fails to advance", async () => {
    // The claim the dispatch-path placement is making. onReviewDecided wraps
    // its whole body in a try/catch that turns a materialisation failure into
    // chain.step_halted, so an engine-fired step event would be lost exactly
    // when an operator most needs to see that a human DID decide. Deleting the
    // route's entry template makes the next materialisation throw.
    const run = await startRun();
    await db.delete(templates).where(eq(templates.slug, "route_tpl"));

    await decide(run.step_1_review_id, "approve", "junior@corp.co");

    const hook = captured.find((c) => c.event === "chain.step_decided");
    expect(hook).toBeDefined();
    expect(hook!.body.decision).toBe("approved");
    expect(hook!.body.step_index).toBe(1);
    // The engine could not advance, and says so separately.
    expect(captured.find((c) => c.event === "chain.step_halted")).toBeDefined();
    expect(captured.find((c) => c.event === "chain.next_step_ready")).toBeUndefined();

    // Restore for the remaining tests in this file.
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "route_tpl",
      project_id: projectId,
      name: "Route",
      fields: [{ name: "amount", type: "number", label: "Amount" }],
      actions: ["approve", "reject"],
    });
  });

  it("a rejection still terminates the run when the entry template is gone", async () => {
    // The abort path re-materialises nothing, so it must not depend on a
    // template lookup. Resolving the entry template eagerly for every
    // rejection meant a run whose template had been deleted threw AFTER the
    // step was claimed 'rejected' — swallowed into chain.step_halted, leaving
    // the run 'active' with no active step. The reconciler only scans runs
    // that HAVE an active step, so that state is a permanent silent strand.
    const run = await startRun();
    await db.delete(templates).where(eq(templates.slug, "route_tpl"));

    await decide(run.step_1_review_id, "reject", "junior@corp.co");

    const [runRow] = await db.select().from(chainRuns).where(eq(chainRuns.id, run.chain_run_id));
    expect(runRow.status).toBe("rejected");
    expect(captured.find((c) => c.event === "chain.rejected")).toBeDefined();
    expect(captured.find((c) => c.event === "chain.step_halted")).toBeUndefined();

    await db.insert(templates).values({
      id: generateId("template"),
      slug: "route_tpl",
      project_id: projectId,
      name: "Route",
      fields: [{ name: "amount", type: "number", label: "Amount" }],
      actions: ["approve", "reject"],
    });
  });

  it("anchors the delivery to the review that decided", async () => {
    const run = await startRun();
    await decide(run.step_1_review_id, "approve", "junior@corp.co");

    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.event_type, "chain.step_decided"));
    expect(rows).toHaveLength(1);
    expect(rows[0].review_id).toBe(run.step_1_review_id);
  });
});

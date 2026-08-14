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

// THE GATE. Charter §6, success criterion 3:
//
//   "An agent integrator reading only the webhook docs cannot confuse an
//    intermediate approval with final authorization (integration-tested)."
//
// This is the one place the route model is RISKIER than the pipeline model it
// replaced, and the charter said so before a line of it was written. Under one
// shared entry template, step 1's approval and the final authorization are the
// same shape, decided the same way, on the same form. If they are also the same
// event on the wire, an agent acts after the junior's yes and before the senior
// ever looks — a governance product handing out an unreviewed approval.
//
// So this file asserts the distinction end to end, over a real three-step route
// driven through the real decision path, with a non-chain control review on the
// same template to prove nothing else moved.

interface Captured {
  body: any;
  event: string;
}

describe("an intermediate approval cannot be mistaken for authorization", () => {
  let db: any;
  let projectId: string;
  let engine: ChainEngine;
  let eventBus: EventBus;
  let webhooks: WebhookService;
  let captured: Captured[];

  const CALLBACK = "https://agent.example.com/cb";

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "expense_approval",
      project_id: projectId,
      name: "Expense approval",
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
        captured.push({
          body: JSON.parse(init.body as string),
          event: headers["X-Webhook-Event"] || "",
        });
        return new Response("", { status: 204 }) as any;
      },
    });
    eventBus = new EventBus();
    engine = new ChainEngine({ db, webhooks, eventBus });
    engine.subscribe(eventBus);
  });

  /** Legal verifies, Finance checks, the VP authorizes. The flagship scenario. */
  const threeStepRoute = (): ChainDefinition =>
    ({
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      template: "expense_approval",
      steps: [
        { id: "legal", name: "Legal", description: "Contract terms", assignee: { kind: "user", email: "legal@corp.co" } },
        { id: "finance", name: "Finance", description: "Budget line", assignee: { kind: "user", email: "finance@corp.co" } },
        { id: "vp", name: "VP", assignee: { kind: "user", email: "vp@corp.co" } },
      ],
    }) as ChainDefinition;

  async function approve(reviewId: string, by: string) {
    await executeReviewAction({
      db, webhooks, eventBus, reviewId, projectId,
      actor: { type: "reviewer", id: by, email: by },
      triggerPath: "dashboard",
      actionId: "approve",
    } as any);
    await new Promise((r) => setTimeout(r, 60));
  }

  async function reviewIdForStep(chainRunId: string, stepNumber: number) {
    const steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, chainRunId));
    return steps.find((s: any) => s.step_number === stepNumber)!.review_id as string;
  }

  it("walks a three-step route and never once says review.decided", async () => {
    const run = await engine.createRun({
      definition: threeStepRoute(),
      initial_payload: { amount: 12000 },
      callback_url: CALLBACK,
      project_id: projectId,
      created_by: "agent:gw_live_test",
    });

    await approve(run.step_1_review_id, "legal@corp.co");
    const s2 = await reviewIdForStep(run.chain_run_id, 2);
    await approve(s2, "finance@corp.co");
    const s3 = await reviewIdForStep(run.chain_run_id, 3);
    await approve(s3, "vp@corp.co");

    // 1. NEITHER review-level decision event is dispatched. review.decided is
    //    the frozen one; review.action_taken is the canonical v1.5 one that
    //    carries action.decision_value and that the public quickstart tells
    //    integrators to key on. Withholding one and shipping the other would
    //    have left the hole exactly where the docs point.
    expect(captured.filter((c) => c.event === "review.decided")).toEqual([]);
    expect(captured.filter((c) => c.event === "review.action_taken")).toEqual([]);

    // 2. Each step announced itself, in order, as its own kind of event.
    const stepEvents = captured.filter((c) => c.event === "chain.step_decided");
    expect(stepEvents.map((c) => c.body.step_index)).toEqual([1, 2, 3]);
    expect(stepEvents.map((c) => c.body.decided_by)).toEqual([
      "legal@corp.co",
      "finance@corp.co",
      "vp@corp.co",
    ]);

    // 3. Authorization is stated exactly once, and only at the end.
    const completed = captured.filter((c) => c.event === "chain.completed");
    expect(completed).toHaveLength(1);
    expect(captured.indexOf(completed[0])).toBeGreaterThan(captured.indexOf(stepEvents[2]));
    expect(completed[0].body.final_review_id).toBe(s3);
    expect(completed[0].body.initial_review_id).toBe(run.step_1_review_id);
    expect(completed[0].body.final_decision).toBe("approved");
    expect(completed[0].body.approved_value).toEqual({ amount: 12000 });
  });

  it("offers no field from which an integrator could infer finality early", async () => {
    // The trap the charter's rejected option (D) walked into: ship step_index
    // beside total_steps and every consumer derives "this was the last one".
    // It is unsound — the branch rejection policy re-runs steps in place — and
    // it is exactly the inference this whole design exists to prevent.
    const run = await engine.createRun({
      definition: threeStepRoute(),
      initial_payload: { amount: 12000 },
      callback_url: CALLBACK,
      project_id: projectId,
      created_by: "agent:gw_live_test",
    });
    await approve(run.step_1_review_id, "legal@corp.co");
    const s2 = await reviewIdForStep(run.chain_run_id, 2);
    await approve(s2, "finance@corp.co");

    const beforeAuthorization = captured.filter((c) => c.event !== "chain.completed");
    expect(beforeAuthorization.length).toBeGreaterThan(0);
    for (const delivery of beforeAuthorization) {
      expect(delivery.body).not.toHaveProperty("is_final");
      expect(delivery.body).not.toHaveProperty("total_steps");
      expect(delivery.body).not.toHaveProperty("steps_remaining");
    }
    // And the authorization has not been claimed yet.
    expect(captured.filter((c) => c.event === "chain.completed")).toEqual([]);
  });

  it("materialises every step against the entry template", async () => {
    const run = await engine.createRun({
      definition: threeStepRoute(),
      initial_payload: { amount: 12000 },
      callback_url: CALLBACK,
      project_id: projectId,
      created_by: "agent:gw_live_test",
    });
    await approve(run.step_1_review_id, "legal@corp.co");
    const s2 = await reviewIdForStep(run.chain_run_id, 2);
    await approve(s2, "finance@corp.co");

    const rows = await db.select().from(reviews).where(eq(reviews.chain_run_id, run.chain_run_id));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.template_slug).toBe("expense_approval");
      // The two worker landmines stay defused for every step of the route.
      expect(r.timeout_action).toBe("expire");
      expect(r.expires_at).toBeNull();
      expect(r.max_iterations).toBeNull();
    }
  });

  it("leaves an ordinary review on the same template completely alone", async () => {
    // The regression fence. Suppression is scoped to chain-attached reviews;
    // a standalone review on the very same template still gets the frozen v1
    // payload, unchanged, byte for byte in its key set.
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_slug: "expense_approval",
      payload: { amount: 300 },
      status: "pending",
      callback_url: CALLBACK,
      current_version: 1,
    });

    await approve(reviewId, "solo@corp.co");

    const decided = captured.filter((c) => c.event === "review.decided");
    expect(decided).toHaveLength(1);
    // The canonical action event is unaffected for a non-chain review.
    expect(captured.filter((c) => c.event === "review.action_taken")).toHaveLength(1);
    expect(decided[0].body.type).toBe("review.decided");
    expect(decided[0].body.review_id).toBe(reviewId);
    expect(decided[0].body.decision).toBe("approved");
    // No chain vocabulary leaked onto a non-chain review.
    expect(decided[0].body).not.toHaveProperty("chain_run_id");
    expect(captured.filter((c) => c.event === "chain.step_decided")).toEqual([]);
  });
});

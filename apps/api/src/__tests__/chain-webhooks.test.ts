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
import { createAuditService } from "../services/audit";

// Webhook payload shape + emission ordering for chain events. Stubs fetch,
// captures each delivery, and asserts the payload against the
// chain-and-escalation §8 shape.

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
  return { engine, webhooks, captured };
}

async function seedTemplates(db: any, projectId: string) {
  const slugs = ["wh_tpl_1", "wh_tpl_2"];
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
  // Let fire-and-forget webhook promises resolve.
  await new Promise((r) => setTimeout(r, 50));
}

describe("Chain webhook payloads", () => {
  let db: any;
  let projectId: string;
  let engine: ChainEngine;
  let captured: Captured[];
  let slugs: string[];

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    slugs = await seedTemplates(db, projectId);
    const e = createCapturingEngine(db);
    engine = e.engine;
    captured = e.captured;
  });

  beforeEach(async () => {
    captured.length = 0;
    await db.delete(webhookDeliveries);
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
  });

  it("chain.next_step_ready fires on step 1 approval with correct payload shape", async () => {
    const result = await engine.createRun({
      definition: twoStep(slugs),
      initial_payload: { content: "a" },
      callback_url: "https://hooks.example.com/x",
      project_id: projectId,
      created_by: "agent:test",
    });

    await db.update(reviews).set({
      status: "decided", decision: "approved",
      decided_by: "alice", decided_at: new Date(), updated_at: new Date(),
    }).where(eq(reviews.id, result.step_1_review_id));

    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);
    await flushAsync();

    const nextStepHook = captured.find((c) => c.event === "chain.next_step_ready");
    expect(nextStepHook).toBeDefined();
    expect(nextStepHook!.body.type).toBe("chain.next_step_ready");
    expect(nextStepHook!.body.chain_run_id).toBe(result.chain_run_id);
    expect(nextStepHook!.body.step_number).toBe(2);
    expect(nextStepHook!.body.previous_step_id).toBe(result.step_1_review_id);
    expect(nextStepHook!.body.next_review_id).toMatch(/^gw_rev_/);
    expect(nextStepHook!.body.assignee).toMatchObject({ kind: "user", email: "bob@x.com" });
    expect(nextStepHook!.headers["X-Webhook-Signature"]).toMatch(/^sha256=/);
    expect(nextStepHook!.headers["X-Webhook-Signature-V2"]).toMatch(/^t=\d+,v1=/);
  });

  it("chain.completed fires on final step approval with full transcript", async () => {
    const result = await engine.createRun({
      definition: twoStep(slugs),
      initial_payload: { content: "a" },
      callback_url: "https://hooks.example.com/x",
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
    await flushAsync();

    // Approve step 2 (final)
    const steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
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
    await flushAsync();

    const completedHook = captured.find((c) => c.event === "chain.completed");
    expect(completedHook).toBeDefined();
    expect(completedHook!.body.type).toBe("chain.completed");
    expect(completedHook!.body.status).toBe("completed");
    expect(completedHook!.body.chain_run_id).toBe(result.chain_run_id);
    expect(completedHook!.body.transcript).toHaveLength(2);
    expect(completedHook!.body.transcript[0]).toMatchObject({
      step_number: 1, decision: "approved", decided_by: "alice",
    });
    expect(completedHook!.body.transcript[1]).toMatchObject({
      step_number: 2, decision: "approved", decided_by: "bob",
    });
  });

  it("chain.rejected fires on step rejection (terminate) with transcript so far", async () => {
    const result = await engine.createRun({
      definition: twoStep(slugs),
      initial_payload: {},
      callback_url: "https://hooks.example.com/x",
      project_id: projectId,
      created_by: "agent:test",
    });

    await db.update(reviews).set({
      status: "decided", decision: "rejected",
      decided_by: "alice", decided_at: new Date(),
      feedback: "budget", updated_at: new Date(),
    }).where(eq(reviews.id, result.step_1_review_id));

    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);
    await flushAsync();

    const rejectedHook = captured.find((c) => c.event === "chain.rejected");
    expect(rejectedHook).toBeDefined();
    expect(rejectedHook!.body.type).toBe("chain.rejected");
    expect(rejectedHook!.body.status).toBe("rejected");
    expect(rejectedHook!.body.rejecting_step_number).toBe(1);
    expect(rejectedHook!.body.rejecting_review_id).toBe(result.step_1_review_id);
    expect(rejectedHook!.body.rejection_feedback).toBe("budget");
    expect(rejectedHook!.body.rejection_policy).toBe("terminate");
    expect(rejectedHook!.body.transcript).toHaveLength(1);
  });

  it("no chain webhooks fire when callback_url is omitted", async () => {
    const result = await engine.createRun({
      definition: twoStep(slugs),
      initial_payload: {},
      // no callback_url
      project_id: projectId,
      created_by: "agent:test",
    });

    await db.update(reviews).set({
      status: "decided", decision: "approved",
      decided_by: "alice", decided_at: new Date(), updated_at: new Date(),
    }).where(eq(reviews.id, result.step_1_review_id));
    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);
    await flushAsync();

    expect(captured.filter((c) => c.event.startsWith("chain."))).toHaveLength(0);
  });

  // MUST be last: deletes slugs[1] template, which other tests need
  it("chain.step_halted fires when materialize throws (template deleted mid-chain)", async () => {
    const result = await engine.createRun({
      definition: twoStep(slugs),
      initial_payload: {},
      callback_url: "https://hooks.example.com/x",
      project_id: projectId,
      created_by: "agent:test",
    });

    // C1: delete the ENTRY template to force template_not_found on advance.
    // Every step materialises against it, so it is the only template whose
    // absence can break a chain mid-run.
    await db.delete(templates).where(eq(templates.slug, slugs[0]));

    await db.update(reviews).set({
      status: "decided", decision: "approved",
      decided_by: "alice", decided_at: new Date(), updated_at: new Date(),
    }).where(eq(reviews.id, result.step_1_review_id));

    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);
    await flushAsync();

    const haltedHook = captured.find((c) => c.event === "chain.step_halted");
    expect(haltedHook).toBeDefined();
    expect(haltedHook!.body.type).toBe("chain.step_halted");
    expect(haltedHook!.body.chain_run_id).toBe(result.chain_run_id);
    expect(haltedHook!.body.review_id).toBe(result.step_1_review_id);
    expect(haltedHook!.body.reason).toBe("materialize_error");
    expect(haltedHook!.headers["X-Webhook-Signature"]).toMatch(/^sha256=/);
  });
});

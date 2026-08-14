import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  auditLog,
  chainRuns,
  chainSteps,
  reviews,
  reviewTokens,
  templates,
} from "@gatewerk/db/src/schema/index";
import { generateId, type ChainDefinition } from "@gatewerk/shared";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { ChainEngine } from "../services/chain-engine";
import { EventBus } from "../services/events";
import { WebhookService } from "../services/webhooks";
import { createAuditService } from "../services/audit";

// End-to-end sequential chain lifecycle (M10 Phase 1). Exercises:
//   * createRun inserts chain_runs + N chain_steps rows and materialises
//     step 1 (creates a review, flips step 1 to active, populates
//     chain_run_id / chain_step_id on the review)
//   * Approving step N advances to step N+1 with prev_step_ids set
//   * Approving the final step completes the chain (chain_runs.status,
//     completed_at set, final chain_steps row approved)

async function makeEngine(db: any) {
  // Stub webhook fetch so deliveries don't try real network I/O. All we
  // care about at this layer is DB state; chain-webhooks.test.ts exercises
  // the payload shape.
  const webhooks = new WebhookService({
    db,
    fetch: async () => new Response("", { status: 204 }) as any,
  });
  const eventBus = new EventBus();
  const auditService = createAuditService(db);
  const engine = new ChainEngine({ db, webhooks, eventBus, auditService, isEmailConfigured: () => true });
  engine.subscribe(eventBus);
  return { engine, eventBus, webhooks };
}

async function seedThreeTemplates(db: any, projectId: string) {
  const slugs = ["tpl_1", "tpl_2", "tpl_3"];
  for (const slug of slugs) {
    await db.insert(templates).values({
      id: generateId("template"),
      slug,
      project_id: projectId,
      name: `Template ${slug}`,
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });
  }
  return slugs;
}

function threeStepDefinition(slugs: string[]): ChainDefinition {
  return {
    version: "1.0",
    mode: "sequential",
    rejection_policy: "terminate",
    steps: [
      { id: "s1", template: slugs[0], assignee: { kind: "user", email: "alice@x.com" } },
      { id: "s2", template: slugs[1], assignee: { kind: "user", email: "bob@x.com" } },
      { id: "s3", template: slugs[2], assignee: { kind: "role", role: "admin" } },
    ],
  };
}

async function decideReview(db: any, reviewId: string, decision: "approved" | "rejected", actor = "user_test") {
  await db.update(reviews).set({
    status: "decided",
    decision,
    decided_by: actor,
    decided_at: new Date(),
    updated_at: new Date(),
  }).where(eq(reviews.id, reviewId));
}

describe("ChainEngine — sequential materialisation", () => {
  let db: any;
  let projectId: string;
  let engine: ChainEngine;
  let eventBus: EventBus;
  let slugs: string[];

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    slugs = await seedThreeTemplates(db, projectId);
    const e = await makeEngine(db);
    engine = e.engine;
    eventBus = e.eventBus;
  });

  beforeEach(async () => {
    // Fast cleanup for isolation — each test gets a fresh chain state.
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
  });

  it("createRun inserts chain_runs + N chain_steps; step 1 materialises into a review", async () => {
    const def = threeStepDefinition(slugs);
    const result = await engine.createRun({
      definition: def,
      initial_payload: { content: "kick off" },
      project_id: projectId,
      created_by: "agent:test",
    });

    expect(result.chain_run_id).toMatch(/^gw_chain_/);
    expect(result.step_1_review_id).toMatch(/^gw_rev_/);
    expect(result.status).toBe("active");

    const [run] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    expect(run.mode).toBe("sequential");
    expect(run.rejection_policy).toBe("terminate");
    expect(run.status).toBe("active");

    const steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    expect(steps).toHaveLength(3);
    const byNumber = steps.sort((a: any, b: any) => a.step_number - b.step_number);
    expect(byNumber[0].status).toBe("active");
    expect(byNumber[0].review_id).toBe(result.step_1_review_id);
    expect(byNumber[0].materialized_at).not.toBeNull();
    expect(byNumber[1].status).toBe("pending");
    expect(byNumber[1].review_id).toBeNull();
    expect(byNumber[2].status).toBe("pending");

    const [step1Review] = await db.select().from(reviews).where(eq(reviews.id, result.step_1_review_id));
    expect(step1Review.chain_run_id).toBe(result.chain_run_id);
    expect(step1Review.chain_step_id).toBe(byNumber[0].id);
    expect(step1Review.prev_step_ids).toEqual([]);
    expect(step1Review.assignee).toBe("alice@x.com"); // user_id lookup fallback (no DB user → email is stored; see engine)
    expect(step1Review.payload).toEqual({ content: "kick off" });
    // P8: chain-spawned step reviews must capture the creation-time snapshot.
    expect(step1Review.template_fields).toEqual([
      { name: "content", type: "text", label: "Content", editable: false },
    ]);
  });

  it("approving step 1 materialises step 2 with prev_step_ids=[step1_review_id]", async () => {
    const def = threeStepDefinition(slugs);
    const result = await engine.createRun({
      definition: def,
      initial_payload: { content: "payload" },
      project_id: projectId,
      created_by: "agent:test",
    });

    await decideReview(db, result.step_1_review_id, "approved");
    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0],
      project_id: projectId,
      priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    const steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const byNumber = steps.sort((a: any, b: any) => a.step_number - b.step_number);
    expect(byNumber[0].status).toBe("approved");
    expect(byNumber[1].status).toBe("active");
    expect(byNumber[1].review_id).not.toBeNull();
    expect(byNumber[2].status).toBe("pending");

    const [step2Review] = await db.select().from(reviews).where(eq(reviews.id, byNumber[1].review_id!));
    expect(step2Review.prev_step_ids).toEqual([result.step_1_review_id]);
    expect(step2Review.chain_run_id).toBe(result.chain_run_id);
    // C1 (route model): every step reviews the same request against the
    // route's ENTRY template. The step's own `template` is ignored, so this
    // is slugs[0] and not slugs[1].
    expect(step2Review.template_slug).toBe(slugs[0]);
  });

  it("approving the final step completes the chain", async () => {
    const def = threeStepDefinition(slugs);
    const result = await engine.createRun({
      definition: def,
      initial_payload: { content: "payload" },
      project_id: projectId,
      created_by: "agent:test",
    });

    // Step 1
    await decideReview(db, result.step_1_review_id, "approved");
    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    // Step 2
    let steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step2 = steps.find((s: any) => s.step_number === 2);
    await decideReview(db, step2.review_id, "approved");
    await engine.onReviewDecided({
      review_id: step2.review_id,
      template: slugs[1], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    // Step 3 (final)
    steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step3 = steps.find((s: any) => s.step_number === 3);
    await decideReview(db, step3.review_id, "approved");
    await engine.onReviewDecided({
      review_id: step3.review_id,
      template: slugs[2], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    const [run] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    expect(run.status).toBe("completed");
    expect(run.completed_at).not.toBeNull();

    steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const byNumber = steps.sort((a: any, b: any) => a.step_number - b.step_number);
    expect(byNumber.map((s: any) => s.status)).toEqual(["approved", "approved", "approved"]);
  });

  it("completing a run started by a reviewer emits chain.completed tapping that reviewer", async () => {
    const def = threeStepDefinition(slugs);
    const result = await engine.createRun({
      definition: def,
      initial_payload: { content: "payload" },
      project_id: projectId,
      created_by: "reviewer:owner@x.co",
    });

    await decideReview(db, result.step_1_review_id, "approved");
    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    let steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step2 = steps.find((s: any) => s.step_number === 2);
    await decideReview(db, step2.review_id, "approved");
    await engine.onReviewDecided({
      review_id: step2.review_id,
      template: slugs[1], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step3 = steps.find((s: any) => s.step_number === 3);
    await decideReview(db, step3.review_id, "approved");

    // Spy AFTER the first two steps so it only observes the final approval,
    // which is the one that completes the chain.
    const emitSpy = vi.spyOn(eventBus, "emit");
    await engine.onReviewDecided({
      review_id: step3.review_id,
      template: slugs[2], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    expect(emitSpy).toHaveBeenCalledWith(
      "chain.completed",
      expect.objectContaining({ notify_assignee: "owner@x.co", review_id: step3.review_id }),
    );
    emitSpy.mockRestore();

    // Fail-open gap: this test asserted the emit but never checked that the
    // run itself actually reached the terminal state the emit is supposed to
    // announce. A broken completeRun that skipped the DB write (but still
    // called the emit) would have passed this test before this assertion.
    const [runAfter] = await db.select().from(chainRuns).where(eq(chainRuns.id, result.chain_run_id));
    expect(runAfter.status).toBe("completed");
    expect(runAfter.completed_at).not.toBeNull();
  });

  it("completing a run started by an agent emits chain.completed with nobody to tap", async () => {
    const def = threeStepDefinition(slugs);
    const result = await engine.createRun({
      definition: def,
      initial_payload: { content: "payload" },
      project_id: projectId,
      created_by: "agent:gwk_x",
    });

    await decideReview(db, result.step_1_review_id, "approved");
    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    let steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step2 = steps.find((s: any) => s.step_number === 2);
    await decideReview(db, step2.review_id, "approved");
    await engine.onReviewDecided({
      review_id: step2.review_id,
      template: slugs[1], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step3 = steps.find((s: any) => s.step_number === 3);
    await decideReview(db, step3.review_id, "approved");

    const emitSpy = vi.spyOn(eventBus, "emit");
    await engine.onReviewDecided({
      review_id: step3.review_id,
      template: slugs[2], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    // C1 §5.1 changed this. The emit used to be gated on a human chain owner,
    // which meant an agent-started chain produced no chain.completed on the bus
    // at all — and the bus is the SSE channel and the channel the SDK wait
    // helpers use to learn a route finished. Gating it left exactly the
    // population that needs the signal without one.
    //
    // The event now always fires. What stays owner-dependent is the
    // NOTIFICATION target: an agent-started chain has no human to tap, so
    // notify_assignee is absent, and PersonalNotifier drops a chain terminal
    // event that has none rather than falling back to the review's assignee
    // (who, for a completed chain, is the last decider — the one person who
    // already knows).
    expect(emitSpy).toHaveBeenCalledWith("chain.completed", expect.anything());
    const call = emitSpy.mock.calls.find((c) => c[0] === "chain.completed")!;
    expect(call[1]).not.toHaveProperty("notify_assignee");
    emitSpy.mockRestore();
  });

  it("payload edits from step N propagate to step N+1", async () => {
    const def = threeStepDefinition(slugs);
    const result = await engine.createRun({
      definition: def,
      initial_payload: { content: "original" },
      project_id: projectId,
      created_by: "agent:test",
    });

    // Step 1 reviewer edits the payload
    await db.update(reviews).set({
      edited_payload: { content: "edited by reviewer" },
      status: "decided",
      decision: "approved",
      decided_by: "alice",
      decided_at: new Date(),
      updated_at: new Date(),
    }).where(eq(reviews.id, result.step_1_review_id));

    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    const steps = await db.select().from(chainSteps).where(eq(chainSteps.chain_run_id, result.chain_run_id));
    const step2 = steps.find((s: any) => s.step_number === 2);
    const [step2Review] = await db.select().from(reviews).where(eq(reviews.id, step2.review_id));
    expect(step2Review.payload).toEqual({ content: "edited by reviewer" });
  });

  it("onReviewDecided is a no-op for reviews not attached to a chain", async () => {
    // Create a standalone (non-chain) review
    const standaloneId = generateId("review");
    await db.insert(reviews).values({
      id: standaloneId,
      project_id: projectId,
      template_id: null,
      template_slug: slugs[0],
      payload: { x: 1 },
      status: "decided",
      decision: "approved",
      decided_by: "user",
      decided_at: new Date(),
      assignee: null,
    });

    // Should not throw even though this review has no chain context
    await engine.onReviewDecided({
      review_id: standaloneId,
      template: slugs[0], project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    // No chain_runs should have been touched
    const runs = await db.select().from(chainRuns);
    expect(runs).toHaveLength(0);
  });

  it("rejects a chain definition whose entry template is missing", async () => {
    // C1: createRun validates ONE template, the route's entry. A later step's
    // `template` is retired and no longer checked, because it is never read.
    const def = threeStepDefinition(slugs);
    def.steps[0].template = "does-not-exist";
    await expect(
      engine.createRun({
        definition: def,
        initial_payload: {},
        project_id: projectId,
        created_by: "agent:test",
      }),
    ).rejects.toMatchObject({ code: "template_not_found" });
  });
});

// external_token assignee resolution + auth-tier wiring + webhook PII
// scrub (§13). Uses a webhook-fetch stub so the scrubbed assignee can be
// inspected directly off the captured body.
interface CapturedWebhook {
  url: string;
  body: any;
  event: string;
}

describe("ChainEngine — external_token chain wiring", () => {
  let db: any;
  let projectId: string;
  let engine: ChainEngine;
  let captured: CapturedWebhook[];

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;

    captured = [];
    const webhooks = new WebhookService({
      db,
      fetch: async (url: any, init: any) => {
        const headers = (init.headers || {}) as Record<string, string>;
        captured.push({
          url: String(url),
          body: JSON.parse(init.body as string),
          event: headers["X-Webhook-Event"] || "",
        });
        return new Response("", { status: 204 }) as any;
      },
    });
    const eventBus = new EventBus();
    const auditService = createAuditService(db);
    engine = new ChainEngine({ db, webhooks, eventBus, auditService, isEmailConfigured: () => true });
    engine.subscribe(eventBus);
  });

  beforeEach(async () => {
    captured.length = 0;
    await db.delete(reviewTokens);
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
  });

  async function seedTemplate(opts: {
    slug: string;
    default_auth_level?: string;
    default_expiry_seconds?: number;
  }) {
    await db.insert(templates).values({
      id: generateId("template"),
      slug: opts.slug,
      project_id: projectId,
      name: `Template ${opts.slug}`,
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      enable_review_links: true,
      default_auth_level: opts.default_auth_level ?? "public",
      default_expiry_seconds: opts.default_expiry_seconds ?? 86400,
    });
  }

  it("T-EXT-1 — minimal external_token assignee materialises with auth_level=public", async () => {
    await seedTemplate({ slug: "ext_min" });
    const def: ChainDefinition = {
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        { id: "s1", template: "ext_min", assignee: { kind: "external_token" } },
      ],
    };
    const result = await engine.createRun({
      definition: def,
      initial_payload: { content: "hi" },
      project_id: projectId,
      created_by: "agent:test",
    });

    const [rev] = await db.select().from(reviews).where(eq(reviews.id, result.step_1_review_id));
    expect(rev.status).toBe("awaiting_external");

    const tokens = await db.select().from(reviewTokens).where(eq(reviewTokens.review_id, rev.id));
    expect(tokens).toHaveLength(1);
    expect(tokens[0].auth_level).toBe("public");
    expect(tokens[0].auth_email).toBeNull();
    expect(tokens[0].auth_user_id).toBeNull();
  });

  it("T-EXT-2 — assignee with auth_level=email_otp wires the token correctly", async () => {
    await seedTemplate({ slug: "ext_otp" });
    const def: ChainDefinition = {
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        {
          id: "s1",
          template: "ext_otp",
          assignee: {
            kind: "external_token",
            auth_level: "email_otp",
            auth_email: "alice@example.com",
          },
        },
      ],
    };
    const result = await engine.createRun({
      definition: def,
      initial_payload: { content: "hi" },
      project_id: projectId,
      created_by: "agent:test",
    });

    const tokens = await db
      .select()
      .from(reviewTokens)
      .where(eq(reviewTokens.review_id, result.step_1_review_id));
    expect(tokens[0].auth_level).toBe("email_otp");
    expect(tokens[0].auth_email).toBe("alice@example.com");
    expect(tokens[0].auth_user_id).toBeNull();

    // H2 closure: the token.created audit row from the chain path MUST
    // surface auth_level (operator-set) but MUST NOT carry auth_email or
    // auth_user_id. PII-as-type-absence — emission scrubbing at every
    // serializing surface, audit details included.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resource_id, result.step_1_review_id));
    const tokenCreated = auditRows.find((r: any) => r.action === "token.created");
    expect(tokenCreated, "token.created audit row should exist").toBeDefined();
    const details = tokenCreated!.details as Record<string, unknown>;
    expect(details.auth_level).toBe("email_otp");
    expect(details).not.toHaveProperty("auth_email");
    expect(details).not.toHaveProperty("auth_user_id");
  });

  it("T-EXT-3 — assignee inherits template.default_auth_level when omitted", async () => {
    await seedTemplate({ slug: "ext_def_account", default_auth_level: "account" });
    const def: ChainDefinition = {
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        {
          id: "s1",
          template: "ext_def_account",
          // No auth_level on the assignee → inherit from template default.
          // auth_user_id provided so the helper-layer gate is satisfied.
          assignee: {
            kind: "external_token",
            auth_user_id: "user_inherit",
          },
        },
      ],
    };
    const result = await engine.createRun({
      definition: def,
      initial_payload: { content: "hi" },
      project_id: projectId,
      created_by: "agent:test",
    });

    const tokens = await db
      .select()
      .from(reviewTokens)
      .where(eq(reviewTokens.review_id, result.step_1_review_id));
    expect(tokens[0].auth_level).toBe("account");
    expect(tokens[0].auth_user_id).toBe("user_inherit");
  });

  it("T-EXT-4 — assignee.recipient_label overrides step.name", async () => {
    await seedTemplate({ slug: "ext_label" });
    const def: ChainDefinition = {
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        {
          id: "s1",
          name: "Step display name",
          template: "ext_label",
          assignee: {
            kind: "external_token",
            recipient_label: "Override label",
          },
        },
      ],
    };
    const result = await engine.createRun({
      definition: def,
      initial_payload: { content: "hi" },
      project_id: projectId,
      created_by: "agent:test",
    });

    const tokens = await db
      .select()
      .from(reviewTokens)
      .where(eq(reviewTokens.review_id, result.step_1_review_id));
    expect(tokens[0].recipient_label).toBe("Override label");
  });

  it("T-EXT-5 — chain.next_step_ready webhook scrubs auth_email + auth_user_id", async () => {
    await seedTemplate({ slug: "ext_wh_a" });
    await seedTemplate({ slug: "ext_wh_b" });
    const def: ChainDefinition = {
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        {
          id: "s1",
          template: "ext_wh_a",
          assignee: { kind: "user", email: "starter@example.com" },
        },
        {
          id: "s2",
          template: "ext_wh_b",
          assignee: {
            kind: "external_token",
            auth_level: "email_otp",
            auth_email: "recipient@example.com",
            recipient_label: "Tier 2 reviewer",
          },
        },
      ],
    };
    const result = await engine.createRun({
      definition: def,
      initial_payload: { content: "hi" },
      callback_url: "https://example.com/cb",
      project_id: projectId,
      created_by: "agent:test",
    });

    // Approve step 1 to fire chain.next_step_ready for step 2.
    await db.update(reviews).set({
      status: "decided",
      decision: "approved",
      decided_by: "alice",
      decided_at: new Date(),
      updated_at: new Date(),
    }).where(eq(reviews.id, result.step_1_review_id));
    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: "ext_wh_a", project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    const nextStep = captured.find((c) => c.event === "chain.next_step_ready");
    expect(nextStep, "chain.next_step_ready webhook should fire").toBeDefined();
    expect(nextStep!.body.external_token_url).toMatch(/^\/r\/gw_tok_/);

    const assignee = nextStep!.body.assignee as Record<string, unknown>;
    // I11 positive control: prove the scrub ran by asserting the
    // PII-safe fields ARE present (operator-set, not recipient-derived)
    // alongside the negative control on the PII fields. Without the
    // positive control, a silent no-op scrub (e.g. early-return on a
    // refactor regression) would still pass the negative-only check.
    expect(assignee.kind).toBe("external_token");
    expect(assignee.auth_level).toBe("email_otp");
    expect(assignee.recipient_label).toBe("Tier 2 reviewer");
    // PII MUST be scrubbed on the wire.
    expect(assignee).not.toHaveProperty("auth_email");
    expect(assignee).not.toHaveProperty("auth_user_id");
  });

  it("T-EXT-5b — chain.next_step_ready webhook scrubs auth_user_id on account tier", async () => {
    await seedTemplate({ slug: "ext_wh_acc_a" });
    await seedTemplate({ slug: "ext_wh_acc_b" });
    const def: ChainDefinition = {
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        {
          id: "s1",
          template: "ext_wh_acc_a",
          assignee: { kind: "user", email: "starter@example.com" },
        },
        {
          id: "s2",
          template: "ext_wh_acc_b",
          assignee: {
            kind: "external_token",
            auth_level: "account",
            auth_user_id: "user_123",
            recipient_label: "Tier 2 reviewer",
          },
        },
      ],
    };
    const result = await engine.createRun({
      definition: def,
      initial_payload: { content: "hi" },
      callback_url: "https://example.com/cb",
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
    await engine.onReviewDecided({
      review_id: result.step_1_review_id,
      template: "ext_wh_acc_a", project_id: projectId, priority: "normal",
      created_at: new Date().toISOString(),
    } as any);

    const nextStep = captured.find((c) => c.event === "chain.next_step_ready");
    expect(nextStep, "chain.next_step_ready webhook should fire").toBeDefined();
    const assignee = nextStep!.body.assignee as Record<string, unknown>;
    expect(assignee.kind).toBe("external_token");
    expect(assignee.auth_level).toBe("account");
    expect(assignee.recipient_label).toBe("Tier 2 reviewer");
    expect(assignee).not.toHaveProperty("auth_user_id");
    expect(assignee).not.toHaveProperty("auth_email");
  });
});

describe("ChainEngine — SMTP guard on email_otp external_token steps", () => {
  let db: any;
  let projectId: string;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;

    await db.insert(templates).values({
      id: generateId("template"),
      slug: "smtp-guard-tpl",
      project_id: projectId,
      name: "SMTP Guard Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      enable_review_links: true,
    });
  });

  beforeEach(async () => {
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
  });

  function makeNoSmtpEngine() {
    const webhooks = new WebhookService({ db, fetch: async () => new Response("", { status: 204 }) as any });
    const eventBus = new EventBus();
    // No isEmailConfigured → default-deny.
    return new ChainEngine({ db, webhooks, eventBus });
  }

  function makeSmtpEngine() {
    const webhooks = new WebhookService({ db, fetch: async () => new Response("", { status: 204 }) as any });
    const eventBus = new EventBus();
    return new ChainEngine({ db, webhooks, eventBus, isEmailConfigured: () => true });
  }

  const emailOtpDef = (): ChainDefinition => ({
    version: "1.0",
    mode: "sequential",
    rejection_policy: "terminate",
    steps: [
      {
        id: "s1",
        template: "smtp-guard-tpl",
        assignee: { kind: "external_token", auth_level: "email_otp", auth_email: "rec@example.com" },
      },
    ],
  });

  it("rejects email_otp external step when SMTP is absent", async () => {
    const engine = makeNoSmtpEngine();
    await expect(
      engine.createRun({ definition: emailOtpDef(), initial_payload: {}, project_id: projectId, created_by: "agent:test" }),
    ).rejects.toMatchObject({ code: "smtp_not_configured" });
  });

  it("leaves no chain_runs or chain_steps rows on rejection (fail-fast)", async () => {
    const engine = makeNoSmtpEngine();
    await engine.createRun({ definition: emailOtpDef(), initial_payload: {}, project_id: projectId, created_by: "agent:test" }).catch(() => {});
    const runs = await db.select().from(chainRuns);
    const steps = await db.select().from(chainSteps);
    expect(runs).toHaveLength(0);
    expect(steps).toHaveLength(0);
  });

  it("creates the run when isEmailConfigured returns true (control)", async () => {
    const engine = makeSmtpEngine();
    const result = await engine.createRun({ definition: emailOtpDef(), initial_payload: {}, project_id: projectId, created_by: "agent:test" });
    expect(result.chain_run_id).toMatch(/^gw_chain_/);
    expect(result.step_1_review_id).toMatch(/^gw_rev_/);
  });
});

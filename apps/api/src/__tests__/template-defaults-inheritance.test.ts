// Template-default inheritance on the DIRECT review-create path.
//
// The chain path (chain-engine.ts materializeStep) inherits `timeout_seconds`
// AND `timeout_action` from the template row. The direct path
// (services/reviews/crud.ts create) inherited NEITHER: it wrote only
// `data.timeout?.action` / `data.timeout?.seconds`, so a template configured
// "24h -> auto_approve" produced a review with timeout_action = NULL, and
// TimeoutWorker.processOne's `review.timeout_action || "expire"` fallback then
// EXPIRED it. The operator configured one behaviour and silently got another,
// with no error anywhere.
//
// The load-bearing assertion in this file is the end-to-end one
// ("worker honours the template's timeout_action"): asserting only the column
// value would let a future refactor that inherits the column but breaks the
// worker hand-off pass. The column assertions localise the failure when it
// does break.

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, reviews as reviewsTable } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { EventBus } from "../services/events";
import { TimeoutWorker } from "../services/timeout-worker";
import { WebhookService } from "../services/webhooks";
import { createReviewCrudSlice } from "../services/reviews/crud";

describe("template-default inheritance — direct review create", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let apiKey: string;

  // Template configured the way an operator would configure "unattended
  // resolution": a 24h window that APPROVES on silence.
  const AUTO_APPROVE_SLUG = "tpl-auto-approve-24h";
  // Same, but rejecting on silence.
  const AUTO_REJECT_SLUG = "tpl-auto-reject";
  // No timeout policy at all.
  const NO_TIMEOUT_SLUG = "tpl-no-timeout";
  // Monitoring-capable template that ALSO carries a timeout_action.
  const MONITORING_SLUG = "tpl-monitoring";
  // Template-level iteration cap.
  const MAX_ITER_SLUG = "tpl-max-iterations";

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;
    app = createApp({ db, eventBus: new EventBus() });

    const field = [{ name: "content", type: "text", label: "Content" }];

    await db.insert(templates).values([
      {
        id: generateId("template"),
        slug: AUTO_APPROVE_SLUG,
        project_id: projectId,
        name: "Auto approve after 24h",
        fields: field,
        actions: ["approve", "reject"],
        timeout_seconds: 86400,
        timeout_action: "auto_approve",
      },
      {
        id: generateId("template"),
        slug: AUTO_REJECT_SLUG,
        project_id: projectId,
        name: "Auto reject",
        fields: field,
        actions: ["approve", "reject"],
        timeout_seconds: 3600,
        timeout_action: "auto_reject",
      },
      {
        id: generateId("template"),
        slug: NO_TIMEOUT_SLUG,
        project_id: projectId,
        name: "No timeout policy",
        fields: field,
        actions: ["approve", "reject"],
      },
      {
        id: generateId("template"),
        slug: MONITORING_SLUG,
        project_id: projectId,
        name: "Monitoring with a timeout action",
        fields: field,
        actions: ["approve", "reject"],
        allow_monitoring: true,
        timeout_seconds: 600,
        timeout_action: "auto_approve",
      },
      {
        id: generateId("template"),
        slug: MAX_ITER_SLUG,
        project_id: projectId,
        name: "Capped iterations",
        fields: field,
        actions: ["approve", "reject"],
        max_iterations: 3,
      },
    ]);
  });

  async function row(id: string) {
    const [r] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, id));
    return r;
  }

  it("inherits timeout_action from the template when the request omits timeout", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: AUTO_APPROVE_SLUG, payload: { content: "unattended" } });

    expect(res.status).toBe(201);
    const r = await row(res.body.id);
    expect(r.timeout_action).toBe("auto_approve");
  });

  it("inherits timeout_seconds from the template when the request omits timeout", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: AUTO_APPROVE_SLUG, payload: { content: "window" } });

    expect(res.status).toBe(201);
    const r = await row(res.body.id);
    // expires_at already derived from the template default before this fix;
    // the persisted column did not, so the row disagreed with its own window.
    expect(r.timeout_seconds).toBe(86400);
    expect(r.expires_at).not.toBeNull();
  });

  it("THE BUG: the worker auto-approves a template-configured review instead of expiring it", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: AUTO_APPROVE_SLUG,
        payload: { content: "nobody looked at this" },
        callback_url: "https://example.com/hook",
      });
    expect(res.status).toBe(201);
    const reviewId = res.body.id;

    // Fast-forward the window rather than waiting 24h. Only expires_at is
    // touched — timeout_action stays exactly as create() wrote it, which is
    // the value under test.
    await db
      .update(reviewsTable)
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(eq(reviewsTable.id, reviewId));

    const worker = new TimeoutWorker({
      db,
      webhooks: new WebhookService({ fetch: vi.fn().mockResolvedValue(new Response("ok")) }),
      eventBus: new EventBus(),
    });
    await worker.processExpired();

    const r = await row(reviewId);
    // Pre-fix this was status='expired', decision=null: the template said
    // "approve on silence" and the product threw the request away instead.
    expect(r.status).toBe("decided");
    expect(r.decision).toBe("approved");
    expect(r.decided_by).toBe("system:timeout");
  });

  it("honours a template configured to auto_reject on silence", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: AUTO_REJECT_SLUG, payload: { content: "deny by default" } });
    expect(res.status).toBe(201);

    await db
      .update(reviewsTable)
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(eq(reviewsTable.id, res.body.id));

    const worker = new TimeoutWorker({
      db,
      webhooks: new WebhookService({ fetch: vi.fn().mockResolvedValue(new Response("ok")) }),
      eventBus: new EventBus(),
    });
    await worker.processExpired();

    const r = await row(res.body.id);
    expect(r.status).toBe("decided");
    expect(r.decision).toBe("rejected");
  });

  it("per-review timeout.action overrides the template default", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: AUTO_APPROVE_SLUG,
        payload: { content: "explicit override" },
        timeout: { seconds: 120, action: "auto_reject" },
      });

    expect(res.status).toBe(201);
    const r = await row(res.body.id);
    expect(r.timeout_action).toBe("auto_reject");
    expect(r.timeout_seconds).toBe(120);
  });

  it("a per-review timeout owns the whole policy — seconds alone is a 422, not an inherit", async () => {
    // Documents the boundary of the inheritance fix rather than extending it.
    // A blocking `timeout` must carry its action (ReviewCreateBodySchema
    // superRefine, locked by reviews-oversight.test.ts). So the template's
    // policy is reachable only when the request omits `timeout` entirely —
    // which is what the tests above cover. Asymmetric with the chain path,
    // where a step overrides timeout_seconds alone and still inherits
    // template.timeout_action; that asymmetry is intentional, not yet closed.
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: AUTO_APPROVE_SLUG,
        payload: { content: "shorter window, no policy" },
        timeout: { seconds: 300 },
      });

    expect(res.status).toBe(422);
    // The message has to name the inheritance path, or the 422 is a dead end.
    expect(JSON.stringify(res.body)).toContain("Omit `timeout` entirely");
  });

  it("a template with no timeout policy still produces an unbounded review", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: NO_TIMEOUT_SLUG, payload: { content: "waits forever" } });

    expect(res.status).toBe(201);
    const r = await row(res.body.id);
    expect(r.timeout_action).toBeNull();
    expect(r.timeout_seconds).toBeNull();
    expect(r.expires_at).toBeNull();
  });

  it("a monitoring review never inherits the template's timeout_action", async () => {
    // Monitoring windows lapse to 'confirmed' via the monitoring sweep, not
    // via processExpired. A non-null timeout_action would let the expiry
    // sweep decide a monitoring review — the invariant crud.ts pins with
    // `data.oversight === "monitoring" ? null : ...`. Inheritance must not
    // reach around it.
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: MONITORING_SLUG,
        payload: { content: "already executed" },
        oversight: "monitoring",
        irreversibility: "reversible",
        callback_url: "https://example.com/hook",
      });

    expect(res.status).toBe(201);
    const r = await row(res.body.id);
    expect(r.status).toBe("monitoring");
    expect(r.timeout_action).toBeNull();
  });

  it("inherits max_iterations from the template (regression lock)", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: MAX_ITER_SLUG, payload: { content: "bounded loop" } });

    expect(res.status).toBe(201);
    const r = await row(res.body.id);
    expect(r.max_iterations).toBe(3);
  });

  it("inherits default_priority from the template (regression lock)", async () => {
    await db
      .update(templates)
      .set({ default_priority: "high" })
      .where(eq(templates.slug, NO_TIMEOUT_SLUG));

    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: NO_TIMEOUT_SLUG, payload: { content: "priority" } });

    expect(res.status).toBe(201);
    const r = await row(res.body.id);
    expect(r.priority).toBe("high");

    await db
      .update(templates)
      .set({ default_priority: "normal" })
      .where(eq(templates.slug, NO_TIMEOUT_SLUG));
  });

  it("the direct path and the chain path resolve the same timeout policy", async () => {
    // Cross-path invariant: the defect existed precisely because these two
    // insert statements disagreed. Lock them together so the next divergence
    // fails here instead of in production.
    const crud = createReviewCrudSlice(db);
    const created = await crud.create(projectId, {
      template: AUTO_REJECT_SLUG,
      payload: { content: "service seam" },
    });

    expect(created.timeout_action).toBe("auto_reject");
    expect(created.timeout_seconds).toBe(3600);
  });
});

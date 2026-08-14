// HOTL monitoring gate — cross-surface guards.
// Verifies every side-door into or around a monitoring review is closed:
// legacy /decide, action pipeline, snooze, bulk archive/delete, DELETE, token
// issuance, and chain-materialized step oversight pin.
//
// Harness mirrors monitoring-create.test.ts / monitoring-actions.test.ts:
// isolated test-db per file, shared beforeAll seed, helpers for fresh rows.

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { templates, reviews as reviewsTable } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { EventBus } from "../services/events";

const MON_SLUG = "guards-mon-tpl";
const PLAIN_SLUG = "guards-plain-tpl";
const CHAIN_STEP_SLUG = "guards-chain-step-tpl";
const CHAIN_SLUG = "guards-chain-tpl";

describe("monitoring guards — cross-surface", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let apiKey: string;
  let sessionToken: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;

    // Chain step template (referenced by chain config)
    await db.insert(templates).values({
      id: generateId("template"),
      slug: CHAIN_STEP_SLUG,
      project_id: projectId,
      name: "Guards Chain Step Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });

    // Monitoring-capable template (no auto_approve, no chain_config)
    await db.insert(templates).values({
      id: generateId("template"),
      slug: MON_SLUG,
      project_id: projectId,
      name: "Guards Monitoring Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      allow_monitoring: true,
      auto_approve: false,
    });

    // Plain blocking template
    await db.insert(templates).values({
      id: generateId("template"),
      slug: PLAIN_SLUG,
      project_id: projectId,
      name: "Guards Plain Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      allow_monitoring: false,
    });

    // Chain template — uses CHAIN_STEP_SLUG for step 1
    await db.insert(templates).values({
      id: generateId("template"),
      slug: CHAIN_SLUG,
      project_id: projectId,
      name: "Guards Chain Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      chain_config: {
        version: "1.0",
        mode: "sequential",
        rejection_policy: "terminate",
        steps: [
          {
            id: "s1",
            template: CHAIN_STEP_SLUG,
            assignee: { kind: "user", email: "chain-reviewer@example.com" },
          },
        ],
      },
    });

    const eventBus = new EventBus();
    app = createApp({ db, eventBus });

    const reviewerSeed = await seedReviewer(db, app, {
      email: "guard-reviewer@example.com",
      role: "admin",
    });
    sessionToken = reviewerSeed.sessionToken;
  });

  const authApi = () => ({ Authorization: `Bearer ${apiKey}` });
  const authSession = () => ({ Authorization: `Bearer ${sessionToken}` });

  async function createMonitoringReview(overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(authApi())
      .send({
        template: MON_SLUG,
        payload: { msg: "test" },
        oversight: "monitoring",
        irreversibility: "reversible",
        callback_url: "https://agent.example/cb",
        timeout: { seconds: 300 },
        ...overrides,
      });
    expect(res.status, `createMonitoringReview failed: ${JSON.stringify(res.body)}`).toBe(201);
    return res.body as { id: string };
  }

  async function createPendingReview(overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(authApi())
      .send({
        template: PLAIN_SLUG,
        payload: { msg: "blocking" },
        ...overrides,
      });
    expect(res.status, `createPendingReview failed: ${JSON.stringify(res.body)}`).toBe(201);
    return res.body as { id: string };
  }

  // A terminal review, for cases that need a row bulk archive/delete is
  // actually allowed to touch (they are gated on decided|expired — see
  // services/reviews/bulk.ts).
  async function createDecidedReview() {
    const review = await createPendingReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${review.id}/decide`)
      .set(authApi())
      .send({ decision: "approved" });
    expect(res.status, `createDecidedReview failed: ${JSON.stringify(res.body)}`).toBe(200);
    return review;
  }

  // ——————————————————————————————————————————
  // G1: Legacy /decide rejects confirmed/vetoed
  // ——————————————————————————————————————————
  it("G1a: legacy /decide rejects decision 'vetoed' with 400 use_monitoring_endpoints; review stays pending", async () => {
    // DANGER: without the guard, decision:'vetoed' maps through the
    // non-rejected→approve alias and would APPROVE the review silently.
    const review = await createPendingReview();

    const res = await request(app)
      .post(`/api/v1/reviews/${review.id}/decide`)
      .set(authSession())
      .send({ decision: "vetoed" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("use_monitoring_endpoints");

    // Critical: assert the review was NOT modified
    const [row] = await db
      .select({ status: reviewsTable.status, decision: reviewsTable.decision })
      .from(reviewsTable)
      .where(eq(reviewsTable.id, review.id))
      .limit(1);
    expect(row.status).toBe("pending");
    expect(row.decision).toBeNull();
  });

  it("G1b: legacy /decide rejects decision 'confirmed' with 400 use_monitoring_endpoints; review stays pending", async () => {
    const review = await createPendingReview();

    const res = await request(app)
      .post(`/api/v1/reviews/${review.id}/decide`)
      .set(authSession())
      .send({ decision: "confirmed" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("use_monitoring_endpoints");

    const [row] = await db
      .select({ status: reviewsTable.status, decision: reviewsTable.decision })
      .from(reviewsTable)
      .where(eq(reviewsTable.id, review.id))
      .limit(1);
    expect(row.status).toBe("pending");
    expect(row.decision).toBeNull();
  });

  // ——————————————————————————————————————————
  // G2: POST /:id/action on a monitoring review
  // ——————————————————————————————————————————
  it("G2: POST /:id/action on a monitoring review → 409 monitoring_requires_veto_or_confirm", async () => {
    const review = await createMonitoringReview();

    const res = await request(app)
      .post(`/api/v1/reviews/${review.id}/action`)
      .set(authSession())
      .send({ action_id: "approve" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("monitoring_requires_veto_or_confirm");
  });

  // ——————————————————————————————————————————
  // G3: POST /:id/decide on a monitoring review
  // ——————————————————————————————————————————
  it("G3: POST /:id/decide on a monitoring review → 409 monitoring_requires_veto_or_confirm", async () => {
    const review = await createMonitoringReview();

    const res = await request(app)
      .post(`/api/v1/reviews/${review.id}/decide`)
      .set(authSession())
      .send({ decision: "approved" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("monitoring_requires_veto_or_confirm");
  });

  // ——————————————————————————————————————————
  // G4: Snooze
  // ——————————————————————————————————————————
  it("G4a: snooze on a monitoring review → 409 monitoring_not_snoozable; snoozed_until stays null", async () => {
    const review = await createMonitoringReview();
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .post(`/api/v1/reviews/${review.id}/snooze`)
      .set(authSession())
      .send({ until });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("monitoring_not_snoozable");

    const [row] = await db
      .select({ snoozed_until: reviewsTable.snoozed_until })
      .from(reviewsTable)
      .where(eq(reviewsTable.id, review.id))
      .limit(1);
    expect(row.snoozed_until).toBeNull();
  });

  it("G4b: snooze on a pending review still works", async () => {
    const review = await createPendingReview();
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .post(`/api/v1/reviews/${review.id}/snooze`)
      .set(authSession())
      .send({ until });

    expect(res.status).toBe(200);
  });

  // ——————————————————————————————————————————
  // G5: Bulk operations skip monitoring rows
  // ——————————————————————————————————————————
  it("G5a: bulk archive skips monitoring rows — count=1, monitoring row survives", async () => {
    const monReview = await createMonitoringReview();
    // Control row must be TERMINAL. This used to be a pending review, which
    // made the test assert that bulk archive flips a live review — the very
    // defect fixed in S1; see bulk-lifecycle-guard.test.ts. The
    // monitoring-skip behaviour this test exists for is unchanged.
    const decidedReview = await createDecidedReview();

    const res = await request(app)
      .post("/api/v1/reviews/bulk/archive")
      .set(authSession())
      .send({ ids: [monReview.id, decidedReview.id] });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    // archived_ids must list exactly what flipped — the client's Undo fans
    // out unarchive calls over this list, so including a skipped monitoring
    // id would produce false "Restored N, M failed" toasts.
    expect(res.body.archived_ids).toEqual([decidedReview.id]);

    const [monRow] = await db
      .select({ status: reviewsTable.status })
      .from(reviewsTable)
      .where(eq(reviewsTable.id, monReview.id))
      .limit(1);
    expect(monRow.status).toBe("monitoring");
  });

  it("G5b: bulk delete skips monitoring rows — count=1, monitoring row survives", async () => {
    const monReview = await createMonitoringReview();
    // Terminal control row, same reason as G5a.
    const decidedReview = await createDecidedReview();

    const res = await request(app)
      .post("/api/v1/reviews/bulk/delete")
      .set(authSession())
      .send({ ids: [monReview.id, decidedReview.id] });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    // Symmetric with archived_ids: deleted_ids lists only what was removed.
    expect(res.body.deleted_ids).toEqual([decidedReview.id]);

    const [monRow] = await db
      .select({ status: reviewsTable.status })
      .from(reviewsTable)
      .where(eq(reviewsTable.id, monReview.id))
      .limit(1);
    expect(monRow).toBeTruthy();
    expect(monRow.status).toBe("monitoring");
  });

  // ——————————————————————————————————————————
  // G6: DELETE /:id
  // ——————————————————————————————————————————
  it("G6a: DELETE /:id on an in-window monitoring review → 409 monitoring_requires_veto_or_confirm; row survives", async () => {
    const review = await createMonitoringReview();

    const res = await request(app)
      .delete(`/api/v1/reviews/${review.id}`)
      .set(authSession());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("monitoring_requires_veto_or_confirm");

    const [row] = await db
      .select({ status: reviewsTable.status })
      .from(reviewsTable)
      .where(eq(reviewsTable.id, review.id))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row.status).toBe("monitoring");
  });

  it("G6b: DELETE /:id after veto (decided) succeeds", async () => {
    const review = await createMonitoringReview();

    // Veto via dedicated endpoint (session-only, human actor)
    const vetoRes = await request(app)
      .post(`/api/v1/reviews/${review.id}/veto`)
      .set(authSession())
      .send({ note: "deleting after veto" });
    expect(vetoRes.status).toBe(200);
    expect(vetoRes.body.decision).toBe("vetoed");

    // Now DELETE should succeed (status is "decided", not "monitoring")
    const delRes = await request(app)
      .delete(`/api/v1/reviews/${review.id}`)
      .set(authSession());

    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);
  });

  // ——————————————————————————————————————————
  // G7: Token issuance
  // ——————————————————————————————————————————
  it("G7: token issuance for a monitoring review → 409 monitoring_not_shareable", async () => {
    const review = await createMonitoringReview();

    // POST /:id/token — the same call ShareViaLinkDialog makes
    const res = await request(app)
      .post(`/api/v1/reviews/${review.id}/token`)
      .set(authSession())
      .send({
        recipient_label: "External Reviewer",
        purpose: "review",
        auth_level: "public",
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("monitoring_not_shareable");
  });

  // ——————————————————————————————————————————
  // G8: PUT /:id (agent version submit) refuses monitoring reviews
  // ——————————————————————————————————————————
  it("G8: PUT /:id (agent version submit) refuses monitoring reviews with 409 not_awaiting_changes", async () => {
    // PUT requires API key auth (api-key sets req.projectId)
    const review = await createMonitoringReview();

    const res = await request(app)
      .put(`/api/v1/reviews/${review.id}`)
      .set(authApi())
      .send({ payload: { msg: "new version" }, version: 2 });

    // lifecycle.updateVersion's iteration allowlist refuses "monitoring"
    // with ConflictError not_awaiting_changes. Pinning the exact code means
    // this test FAILS if anyone widens the allowlist (or reroutes PUT) to
    // let agents mutate a monitoring review's payload mid-window.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("not_awaiting_changes");
  });

  // ——————————————————————————————————————————
  // G9: Chain-materialized step reviews are pinned oversight=blocking
  // ——————————————————————————————————————————
  it("G9: chain-materialized step reviews always have oversight=blocking", async () => {
    // Spawn a chain by POSTing to a template with chain_config.
    // The chain engine materializes step 1 as a review row.
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(authApi())
      .send({
        template: CHAIN_SLUG,
        payload: { content: "chain pin test" },
      });

    expect(res.status, `chain spawn failed: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.chain_run_id).toBeTruthy();

    const [row] = await db
      .select({ oversight: reviewsTable.oversight, chain_run_id: reviewsTable.chain_run_id })
      .from(reviewsTable)
      .where(eq(reviewsTable.id, res.body.id))
      .limit(1);

    expect(row.chain_run_id).toBeTruthy();
    expect(row.oversight).toBe("blocking");
  });
});

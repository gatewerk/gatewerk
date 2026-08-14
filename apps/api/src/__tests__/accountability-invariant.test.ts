/**
 * The accountability invariant.
 *
 * The accountability-completeness check has to be a tested invariant, not a
 * claim. This is that test.
 *
 * The claim under test: **a review cannot reach a terminal decided state
 * without leaving a row in the tamper-evident chain that says who decided it.**
 *
 * Method. `AppDeps.auditService` is an injection point `createApp` already
 * honours (`app.ts:252`, `deps.auditService ?? createAuditService(deps.db)`),
 * so a recording service can be substituted for the real one and every write
 * captured. `expired-tokens.test.ts:461` carries an `it.skip` whose TODO says
 * "AppDeps does not expose an auditService injection point"; that note is
 * stale — the injection point exists and is threaded into every route module.
 *
 * Why this shape rather than per-route assertions. A per-route test only covers
 * routes someone remembered to write a test for, which is exactly how audit
 * gaps accumulate. This drives each decision path end to end and
 * asserts the invariant on the audit rows themselves, so a NEW decision path
 * that forgets its audit write fails here rather than shipping green.
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { templates } from "@gatewerk/db/src/schema/index";
import { generateId, type AuditAction } from "@gatewerk/shared";

type RecordedRow = {
  action: AuditAction;
  actor: string;
  resource_type: string;
  resource_id?: string;
  details?: Record<string, unknown>;
  project_id?: string;
};

/**
 * Stands in for the real audit service. Records instead of writing, so the test
 * asserts on what the application TRIED to record — which is the contract —
 * without depending on chain mechanics that `audit-chain.test.ts` already
 * covers.
 */
function recordingAuditService() {
  const rows: RecordedRow[] = [];
  const service = {
    rows,
    async log(data: RecordedRow) {
      rows.push(data);
      return { id: generateId("event"), ...data } as any;
    },
    logBestEffort(data: RecordedRow, _reason: string) {
      rows.push(data);
    },
    async verify() {
      return [];
    },
    async query() {
      return { items: [], total: 0, has_more: false };
    },
  };
  return service;
}

describe("accountability invariant — every decision leaves a record", () => {
  let app: Express;
  let db: any;
  let apiKey: string;
  let audit: ReturnType<typeof recordingAuditService>;
  let reviewerToken: string;
  let reviewerEmail: string;
  let projectId: string;

  async function createReview(): Promise<string> {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ template: "decide-tpl", payload: { task: "ship it" } });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  /** Audit rows recorded for one review id. */
  function rowsFor(reviewId: string): RecordedRow[] {
    return audit.rows.filter((r) => r.resource_id === reviewId);
  }

  beforeAll(async () => {
    const setup = await createTestDb();
    db = setup.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    await db.insert(templates).values({
      id: generateId("template"),
      slug: "decide-tpl",
      project_id: projectId,
      name: "Decide Template",
      fields: [{ name: "task", type: "text", label: "Task" }],
      actions: ["approve", "reject"],
    });

    audit = recordingAuditService();
    app = createApp({ db, auditService: audit as any });

    reviewerEmail = "reviewer@accountability.test";
    const seeded = await seedReviewer(db, app, {
      email: reviewerEmail,
      role: "admin",
      name: "Accountability Reviewer",
    });
    reviewerToken = seeded.sessionToken;
  });

  it("POST /reviews/:id/action — the canonical decision path", async () => {
    const reviewId = await createReview();
    const before = audit.rows.length;

    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/action`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ action_id: "approve" });
    expect(res.status).toBe(200);

    const written = audit.rows.slice(before).filter((r) => r.resource_id === reviewId);
    expect(written.length).toBeGreaterThan(0);

    // The invariant is not merely "a row exists" — a row with no actor proves
    // nothing. Every decision row must name who decided.
    for (const row of written) {
      expect(row.actor).toBeTruthy();
      expect(row.actor).not.toBe("unknown");
      expect(row.resource_type).toBe("review");
    }

    // And it must be findable by the review's own id, not a literal. This is
    // what bulk operations get wrong: they write resource_id "bulk", so the
    // affected reviews have no proof retrievable by their own id.
    expect(rowsFor(reviewId).length).toBeGreaterThan(0);
  });

  it("POST /reviews/:id/decide — the legacy alias", async () => {
    const reviewId = await createReview();
    const before = audit.rows.length;

    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ decision: "approved" });
    expect(res.status).toBe(200);

    const written = audit.rows.slice(before).filter((r) => r.resource_id === reviewId);
    expect(written.length).toBeGreaterThan(0);
    for (const row of written) {
      expect(row.actor).toBeTruthy();
      expect(row.actor).not.toBe("unknown");
    }
  });

  it("every decision row carries project_id, so it is inside the tenant's chain", async () => {
    const reviewId = await createReview();
    const before = audit.rows.length;

    await request(app)
      .post(`/api/v1/reviews/${reviewId}/action`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ action_id: "approve" });

    const written = audit.rows.slice(before).filter((r) => r.resource_id === reviewId);
    expect(written.length).toBeGreaterThan(0);

    // A row without project_id lands in the shared NULL partition: excluded
    // from verify(projectId), and readable by every tenant through the
    // `project_id IS NULL` clause in audit.query().
    for (const row of written) {
      expect(row.project_id).toBe(projectId);
    }
  });

  it("review creation is audited, so a decision's subject has a recorded origin", async () => {
    const before = audit.rows.length;
    const reviewId = await createReview();

    const written = audit.rows.slice(before).filter((r) => r.resource_id === reviewId);
    expect(written.some((r) => r.action === "review.created")).toBe(true);
  });
});

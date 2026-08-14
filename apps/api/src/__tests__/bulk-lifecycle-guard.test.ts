// Bulk archive / delete must respect the same lifecycle invariant as their
// single-review counterparts (S1).
//
// `lifecycle.archive` requires `status IN ('decided','expired')`. Both bulk
// slices guarded only on `status <> 'monitoring'`, so the two paths disagreed
// on the invariant and the bulk one was strictly more destructive:
//
//   * A live PENDING review — possibly with an external link out — could be
//     archived out of every inbox, or hard-DELETED.
//   * Undo made it worse: `unarchive` derives the restored status from
//     `decided_at`, so a pending review round-tripped to `expired`, which is
//     terminal. Lossy, and the audit row carries only {count, ids}, so the
//     prior status is unrecoverable.
//   * Worst case: archiving the review of an ACTIVE chain step permanently
//     strands the run. `chain-engine-reconcile.ts` skips any review that is
//     neither decided nor expired, and its orphan-halt branch requires
//     `review_id IS NULL`, which archiving does not do. The run stays `active`
//     with no reviewable review in any inbox, forever, with no audit row.
//     Recovery is manual SQL. Single-review archive cannot reach this state.
//
// This is not a legacy-only path: apps/web-next's BulkBar wires both buttons to
// a selection filtered to OPEN (non-terminal) statuses, with no Undo.

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import {
  templates,
  reviews as reviewsTable,
  chainRuns,
  chainSteps,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { EventBus } from "../services/events";

describe("bulk archive / delete lifecycle guard", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let apiKey: string;
  let templateId: string;

  const SLUG = "bulk-guard";
  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;
    app = createApp({ db, eventBus: new EventBus() });

    templateId = generateId("template");
    await db.insert(templates).values({
      id: templateId,
      slug: SLUG,
      project_id: projectId,
      name: "Bulk guard",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      allow_monitoring: true,
    });
  });

  async function seedReview(status: string, extra: Record<string, unknown> = {}) {
    const id = generateId("review");
    await db.insert(reviewsTable).values({
      id,
      project_id: projectId,
      template_id: templateId,
      template_slug: SLUG,
      payload: { content: status },
      status,
      current_version: 1,
      ...extra,
    });
    return id;
  }

  async function statusOf(id: string) {
    const [r] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, id));
    return r?.status ?? null;
  }

  it("archives only decided and expired reviews out of a mixed selection", async () => {
    const pending = await seedReview("pending");
    const decided = await seedReview("decided", { decided_at: new Date(), decision: "approved" });
    const expired = await seedReview("expired");
    const monitoring = await seedReview("monitoring", { expires_at: new Date(Date.now() + 60_000) });
    const awaitingExternal = await seedReview("awaiting_external");
    const awaitingIteration = await seedReview("awaiting_iteration");

    const ids = [pending, decided, expired, monitoring, awaitingExternal, awaitingIteration];
    const res = await request(app)
      .post("/api/v1/reviews/bulk/archive")
      .set(auth())
      .send({ ids });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect([...res.body.archived_ids].sort()).toEqual([decided, expired].sort());

    expect(await statusOf(pending)).toBe("pending");
    expect(await statusOf(monitoring)).toBe("monitoring");
    expect(await statusOf(awaitingExternal)).toBe("awaiting_external");
    expect(await statusOf(awaitingIteration)).toBe("awaiting_iteration");
    expect(await statusOf(decided)).toBe("archived");
    expect(await statusOf(expired)).toBe("archived");
  });

  it("deletes only decided and expired reviews out of a mixed selection", async () => {
    const pending = await seedReview("pending");
    const decided = await seedReview("decided", { decided_at: new Date(), decision: "approved" });
    const awaitingExternal = await seedReview("awaiting_external");

    const res = await request(app)
      .post("/api/v1/reviews/bulk/delete")
      .set(auth())
      .send({ ids: [pending, decided, awaitingExternal] });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.deleted_ids).toEqual([decided]);

    const survivors = await db
      .select({ id: reviewsTable.id })
      .from(reviewsTable)
      .where(inArray(reviewsTable.id, [pending, decided, awaitingExternal]));
    expect(survivors.map((r: any) => r.id).sort()).toEqual([pending, awaitingExternal].sort());
  });

  it("cannot strand an active chain run by archiving its live step review", async () => {
    // The failure this exists to prevent: 'archived' is neither decided nor
    // expired, so chain-engine-reconcile skips the step forever; and
    // review_id stays set, so the orphan-halt branch never fires either.
    const runId = generateId("chain_run");
    await db.insert(chainRuns).values({
      id: runId,
      project_id: projectId,
      template_id: templateId,
      status: "active",
      created_by: "reviewer:test",
    });
    const reviewId = await seedReview("pending", { chain_run_id: runId });
    const stepId = generateId("chain_step");
    await db.insert(chainSteps).values({
      id: stepId,
      chain_run_id: runId,
      step_number: 1,
      review_id: reviewId,
      assignee_spec: { kind: "user", user: "someone@example.com" },
      status: "active",
    });

    const res = await request(app)
      .post("/api/v1/reviews/bulk/archive")
      .set(auth())
      .send({ ids: [reviewId] });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(await statusOf(reviewId)).toBe("pending");

    const [step] = await db.select().from(chainSteps).where(eq(chainSteps.id, stepId));
    expect(step.status).toBe("active");
  });

  it("cannot strand an active chain run by archiving a DECIDED step review", async () => {
    // The hole the status guard alone leaves open, and the one that matters
    // now: a step's review is decided but its chain_steps row is still 'active'
    // — the window before the engine advances, or forever if the engine threw.
    // 'decided' passes the status guard, so archiving it was allowed, and
    // archiving flips the status to a value chain-engine-reconcile skips. The
    // run is then active with no reviewable review and no orphan-halt trigger.
    //
    // C1 raised the cost of this: a chain step no longer emits review.decided
    // to the callback_url, so a stranded run is now silent on the wire too.
    const runId = generateId("chain_run");
    await db.insert(chainRuns).values({
      id: runId,
      project_id: projectId,
      template_id: templateId,
      status: "active",
      created_by: "reviewer:test",
    });
    const reviewId = await seedReview("decided", { chain_run_id: runId });
    await db.insert(chainSteps).values({
      id: generateId("chain_step"),
      chain_run_id: runId,
      step_number: 1,
      review_id: reviewId,
      assignee_spec: { kind: "user", user: "someone@example.com" },
      status: "active",
    });

    const res = await request(app)
      .post("/api/v1/reviews/bulk/archive")
      .set(auth())
      .send({ ids: [reviewId] });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(await statusOf(reviewId)).toBe("decided");
  });

  it("archives a decided step review once its chain run is no longer active", async () => {
    // The guard is scoped to LIVE runs. A completed run's reviews are ordinary
    // history and must stay archivable, or every chain review would be
    // permanently unfileable.
    const runId = generateId("chain_run");
    await db.insert(chainRuns).values({
      id: runId,
      project_id: projectId,
      template_id: templateId,
      status: "completed",
      created_by: "reviewer:test",
    });
    const reviewId = await seedReview("decided", { chain_run_id: runId });
    await db.insert(chainSteps).values({
      id: generateId("chain_step"),
      chain_run_id: runId,
      step_number: 1,
      review_id: reviewId,
      assignee_spec: { kind: "user", user: "someone@example.com" },
      status: "approved",
    });

    const res = await request(app)
      .post("/api/v1/reviews/bulk/archive")
      .set(auth())
      .send({ ids: [reviewId] });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(await statusOf(reviewId)).toBe("archived");
  });

  it("reports zero rather than erroring when nothing in the selection is archivable", async () => {
    // archived_ids is what the client's Undo targets, so an all-skipped
    // selection must degrade to an empty list, not a 4xx.
    const pending = await seedReview("pending");
    const res = await request(app)
      .post("/api/v1/reviews/bulk/archive")
      .set(auth())
      .send({ ids: [pending] });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.archived_ids).toEqual([]);
  });

  it("agrees with single-review archive on the same review", async () => {
    // The invariant the two paths disagreed on. Both must now refuse.
    const pending = await seedReview("pending");

    const single = await request(app)
      .post(`/api/v1/reviews/${pending}/archive`)
      .set(auth())
      .send({});
    expect(single.status).toBe(404);

    const bulk = await request(app)
      .post("/api/v1/reviews/bulk/archive")
      .set(auth())
      .send({ ids: [pending] });
    expect(bulk.body.count).toBe(0);
  });
});

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import {
  chainRuns,
  chainSteps,
  reviews,
  reviewers,
  templates,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { config } from "../config";

// M11.1 integration coverage: POST /api/v1/reviews/:id/cancel-request
// enforces the chain-step policy gate when the review belongs to a
// chain_run. Mirrors decide-chain-policy.test.ts; the endpoint expects
// the review in iteration status, seeded directly here. Updated to
// canonical 'awaiting_iteration' post-migration-033 (storage no longer
// permits the legacy 'changes_requested' value).

async function createChainRunInAwaitingIteration(db: any, opts: {
  projectId: string;
  createdBy: string;
  step1Assignee: { kind: "user"; email: string } | { kind: "role"; role: string };
  templateSlug: string;
  reviewAssigneeCol: string | null;
}): Promise<{ chainRunId: string; reviewId: string; chainStepId: string }> {
  const chainRunId = generateId("chain_run");
  const chainStepId = generateId("chain_step");
  const reviewId = generateId("review");

  await db.insert(chainRuns).values({
    id: chainRunId,
    project_id: opts.projectId,
    template_id: null,
    name: null,
    mode: "sequential",
    rejection_policy: "terminate",
    status: "active",
    metadata: null,
    created_by: opts.createdBy,
    created_at: new Date(),
  });

  await db.insert(reviews).values({
    id: reviewId,
    project_id: opts.projectId,
    template_id: null,
    template_slug: opts.templateSlug,
    payload: { content: "chain payload" },
    priority: "normal",
    actions: ["approve", "reject"],
    assignee: opts.reviewAssigneeCol,
    callback_url: null,
    status: "awaiting_iteration",
    feedback: "please rephrase the second paragraph",
    chain_run_id: chainRunId,
    chain_step_id: chainStepId,
    prev_step_ids: [],
    current_version: 1,
    ladder_index: 0,
  });

  await db.insert(chainSteps).values({
    id: chainStepId,
    chain_run_id: chainRunId,
    step_number: 1,
    review_id: reviewId,
    assignee_spec: {
      id: "s1",
      template: opts.templateSlug,
      assignee: opts.step1Assignee,
    } as any,
    depends_on: null,
    status: "active",
    materialized_at: new Date(),
  });

  return { chainRunId, reviewId, chainStepId };
}

describe("POST /api/v1/reviews/:id/cancel-request — chain-step policy gate (M11.1)", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let templateSlug: string;

  let aliceId: string;
  let bobId: string;
  let adminId: string;
  let ownerId: string;
  let aliceEmail: string;
  let bobEmail: string;
  let adminEmail: string;
  let ownerEmail: string;
  let aliceToken: string;
  let bobToken: string;
  let adminToken: string;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;

    templateSlug = "m11_cancel_chain_tpl";
    await db.insert(templates).values({
      id: generateId("template"),
      slug: templateSlug,
      project_id: projectId,
      name: templateSlug,
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });

    aliceId = generateId("user");
    bobId = generateId("user");
    adminId = generateId("user");
    ownerId = generateId("user");
    aliceEmail = "alice-m11c@example.com";
    bobEmail = "bob-m11c@example.com";
    adminEmail = "admin-m11c@example.com";
    ownerEmail = "owner-m11c@example.com";

    await db.insert(reviewers).values([
      { id: aliceId, email: aliceEmail, name: "Alice", password_hash: "x", role: "reviewer", is_active: true },
      { id: bobId, email: bobEmail, name: "Bob", password_hash: "x", role: "reviewer", is_active: true },
      { id: adminId, email: adminEmail, name: "Admin", password_hash: "x", role: "admin", is_active: true },
      { id: ownerId, email: ownerEmail, name: "Owner", password_hash: "x", role: "reviewer", is_active: true },
    ]);

    const jwtOpts = { audience: "gatewerk-dashboard", issuer: "gatewerk-api" } as const;
    aliceToken = jwt.sign({ sub: aliceId, email: aliceEmail }, config.jwtSecret, jwtOpts);
    bobToken = jwt.sign({ sub: bobId, email: bobEmail }, config.jwtSecret, jwtOpts);
    adminToken = jwt.sign({ sub: adminId, email: adminEmail }, config.jwtSecret, jwtOpts);

    app = createApp({ db });
  });

  beforeEach(async () => {
    await db.delete(reviews).where(eq(reviews.project_id, projectId));
    await db.delete(chainSteps);
    await db.delete(chainRuns);
  });

  const sessionAuth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it("allows /cancel-request when session email matches step assignee", async () => {
    const { reviewId } = await createChainRunInAwaitingIteration(db, {
      projectId,
      createdBy: `reviewer:${ownerEmail}`,
      step1Assignee: { kind: "user", email: aliceEmail },
      templateSlug,
      reviewAssigneeCol: aliceEmail,
    });

    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/cancel-request`)
      .set(sessionAuth(aliceToken))
      .send();

    expect(res.status).toBe(200);
    expect(res.body?.id || res.body?.review?.id).toBe(reviewId);
  });

  it("denies /cancel-request when session email does not match (and not admin/owner)", async () => {
    const { reviewId } = await createChainRunInAwaitingIteration(db, {
      projectId,
      createdBy: `reviewer:${ownerEmail}`,
      step1Assignee: { kind: "user", email: aliceEmail },
      templateSlug,
      reviewAssigneeCol: aliceEmail,
    });

    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/cancel-request`)
      .set(sessionAuth(bobToken))
      .send();

    expect(res.status).toBe(403);
  });

  it("admin bypass on /cancel-request", async () => {
    const { reviewId } = await createChainRunInAwaitingIteration(db, {
      projectId,
      createdBy: `reviewer:${ownerEmail}`,
      step1Assignee: { kind: "user", email: aliceEmail },
      templateSlug,
      reviewAssigneeCol: aliceEmail,
    });

    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/cancel-request`)
      .set(sessionAuth(adminToken))
      .send();

    expect(res.status).toBe(200);
  });
});

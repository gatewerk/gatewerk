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

// M11 integration coverage: POST /api/v1/reviews/:id/decide enforces
// chain-step policy when the review belongs to a chain_run. Non-chain
// reviews retain pre-M11 behavior (scope middleware only).

async function createChainRun(db: any, opts: {
  projectId: string;
  createdBy: string;
  step1Assignee: { kind: "user"; email: string } | { kind: "role"; role: string };
  templateSlug: string;
  reviewAssigneeCol: string | null;
}): Promise<{ chainRunId: string; reviewId: string; chainStepId: string }> {
  // Mirrors what ChainEngine.createRun does but inline so the test controls
  // the exact step 1 assignee shape and bypasses template-lookup validation
  // (which we don't need to re-exercise here).
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

  // Insert the review first — chain_steps.review_id has a FK to reviews(id).
  // The schema uses ON DELETE SET NULL so we could null-then-update, but
  // ordering is cleaner.
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
    status: "pending",
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

describe("POST /api/v1/reviews/:id/decide — chain-step policy gate (M11)", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let apiKey: string;
  let templateSlug: string;

  // Session tokens for three distinct reviewers:
  //  * alice: matches step 1 email assignee
  //  * bob:   session reviewer with a non-matching email
  //  * admin: role=admin bypass
  //  * owner: chain_runs.created_by references this user
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
  let ownerToken: string;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;

    templateSlug = "m11_chain_tpl";
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
    aliceEmail = "alice-m11@example.com";
    bobEmail = "bob-m11@example.com";
    adminEmail = "admin-m11@example.com";
    ownerEmail = "owner-m11@example.com";

    await db.insert(reviewers).values([
      {
        id: aliceId,
        email: aliceEmail,
        name: "Alice",
        password_hash: "unused-in-jwt-test",
        role: "reviewer",
        is_active: true,
      },
      {
        id: bobId,
        email: bobEmail,
        name: "Bob",
        password_hash: "unused-in-jwt-test",
        role: "reviewer",
        is_active: true,
      },
      {
        id: adminId,
        email: adminEmail,
        name: "Admin",
        password_hash: "unused-in-jwt-test",
        role: "admin",
        is_active: true,
      },
      {
        id: ownerId,
        email: ownerEmail,
        name: "Owner",
        password_hash: "unused-in-jwt-test",
        role: "reviewer",
        is_active: true,
      },
    ]);

    const jwtOpts = { audience: "gatewerk-dashboard", issuer: "gatewerk-api" } as const;
    aliceToken = jwt.sign({ sub: aliceId, email: aliceEmail }, config.jwtSecret, jwtOpts);
    bobToken = jwt.sign({ sub: bobId, email: bobEmail }, config.jwtSecret, jwtOpts);
    adminToken = jwt.sign({ sub: adminId, email: adminEmail }, config.jwtSecret, jwtOpts);
    ownerToken = jwt.sign({ sub: ownerId, email: ownerEmail }, config.jwtSecret, jwtOpts);

    app = createApp({ db });
  });

  beforeEach(async () => {
    // Each test gets a fresh chain so previous decisions don't leak.
    await db.delete(reviews).where(eq(reviews.project_id, projectId));
    await db.delete(chainSteps);
    await db.delete(chainRuns);
  });

  const sessionAuth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const apiKeyAuth = () => ({ Authorization: `Bearer ${apiKey}` });

  it("allows step 1 decide when the session email matches the step_assignee email", async () => {
    const { reviewId } = await createChainRun(db, {
      projectId,
      createdBy: `reviewer:${ownerEmail}`,
      step1Assignee: { kind: "user", email: aliceEmail },
      templateSlug,
      reviewAssigneeCol: aliceEmail,
    });

    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set(sessionAuth(aliceToken))
      .send({ decision: "approved" });

    expect(res.status).toBe(200);
    expect(res.body?.id || res.body?.review?.id).toBe(reviewId);
  });

  it("denies step 1 decide when the session email does not match and user is not admin/owner", async () => {
    const { reviewId } = await createChainRun(db, {
      projectId,
      createdBy: `reviewer:${ownerEmail}`,
      step1Assignee: { kind: "user", email: aliceEmail },
      templateSlug,
      reviewAssigneeCol: aliceEmail,
    });

    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set(sessionAuth(bobToken))
      .send({ decision: "approved" });

    expect(res.status).toBe(403);
  });

  it("allows decide when session role is admin (admin bypass)", async () => {
    const { reviewId } = await createChainRun(db, {
      projectId,
      createdBy: `reviewer:${ownerEmail}`,
      step1Assignee: { kind: "user", email: aliceEmail },
      templateSlug,
      reviewAssigneeCol: aliceEmail,
    });

    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set(sessionAuth(adminToken))
      .send({ decision: "approved" });

    expect(res.status).toBe(200);
  });

  it("allows decide when session user is the chain owner (chain_runs.created_by match)", async () => {
    const { reviewId } = await createChainRun(db, {
      projectId,
      createdBy: `reviewer:${ownerEmail}`,
      step1Assignee: { kind: "user", email: aliceEmail },
      templateSlug,
      reviewAssigneeCol: aliceEmail,
    });

    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set(sessionAuth(ownerToken))
      .send({ decision: "approved" });

    expect(res.status).toBe(200);
  });

  it("leaves non-chain reviews unaffected: api_key with reviews:decide succeeds", async () => {
    // Standalone review (no chain_run_id) — the chain-step gate must be a
    // no-op and the existing scope-based path continues to work.
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: null,
      template_slug: templateSlug,
      payload: { content: "standalone" },
      priority: "normal",
      actions: ["approve", "reject"],
      assignee: null,
      callback_url: null,
      status: "pending",
      chain_run_id: null,
      chain_step_id: null,
      prev_step_ids: [],
      current_version: 1,
      ladder_index: 0,
    });

    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set(apiKeyAuth())
      .send({ decision: "approved" });

    expect(res.status).toBe(200);
  });

  it("denies chain-attached decide via api_key (machines are not chain participants)", async () => {
    // Regression guard: the api_key had reviews:decide scope and could
    // previously decide any review; after M11 it must be blocked for
    // chain-attached reviews unless it somehow matches owner/role/email —
    // which api_keys structurally cannot.
    const { reviewId } = await createChainRun(db, {
      projectId,
      createdBy: `reviewer:${ownerEmail}`,
      step1Assignee: { kind: "user", email: aliceEmail },
      templateSlug,
      reviewAssigneeCol: aliceEmail,
    });

    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set(apiKeyAuth())
      .send({ decision: "approved" });

    expect(res.status).toBe(403);
  });
});

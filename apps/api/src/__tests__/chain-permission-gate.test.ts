import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import {
  chainRuns,
  chainSteps,
  reviews,
  reviewers,
  templates,
  apiKeys,
  auditLog,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { buildChainAwareSubject, can } from "../policy";
import { config } from "../config";

// Task 3: Chain permission gate hardening.
//
// CLOSE  — fail-closed gate: half-state review (chain_run_id + chain_step_id
//          set but rows missing) returns a denying chain_step subject, not
//          the original requester (fail-open hole).
// SCOPE  — POST /chain-runs and /abort require chains:create, not
//          templates:write.
// SADMIN — session-admin can POST /chain-runs without projectId (resolveProjectId
//          oldest-project fallback).
// BYPASS — admin deciding a chain step fires chain.admin_bypass audit event.

const TEMPLATE_SLUG = "chain_perm_tpl";
const TEMPLATE_SLUG_2 = "chain_perm_tpl_2";

async function seedTemplates(db: any, projectId: string) {
  for (const slug of [TEMPLATE_SLUG, TEMPLATE_SLUG_2]) {
    await db.insert(templates).values({
      id: generateId("template"),
      slug,
      project_id: projectId,
      name: slug,
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });
  }
}

function validChainBody() {
  return {
    definition: {
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        { id: "s1", template: TEMPLATE_SLUG, assignee: { kind: "user", email: "alice@x.com" } },
        { id: "s2", template: TEMPLATE_SLUG_2, assignee: { kind: "user", email: "bob@x.com" } },
      ],
    },
    initial_payload: { content: "perm-test" },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Step 3: fail-closed gate
// ────────────────────────────────────────────────────────────────────────────
describe("Chain permission gate — CLOSE: fail-closed on half-state", () => {
  let db: any;
  let projectId: string;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    await seedTemplates(db, projectId);
  });

  it("CLOSE-1: review with chain_run_id+chain_step_id but missing rows → denying chain_step subject", async () => {
    // Insert a review that appears chain-attached but whose chain_run_id and
    // chain_step_id point to rows that don't exist (half-state).
    const phantomRunId = "gw_chain_phantom_run00000";
    const phantomStepId = "gw_cstep_phantom_step0000";
    const reviewId = generateId("review");

    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_slug: TEMPLATE_SLUG,
      payload: { content: "half-state" },
      priority: "normal",
      actions: ["approve", "reject"],
      status: "pending",
      chain_run_id: phantomRunId,   // set
      chain_step_id: phantomStepId, // set — but no chain_runs / chain_steps row exists
      current_version: 1,
      ladder_index: 0,
    });

    const requester = {
      kind: "session" as const,
      userId: "u_reviewer",
      role: "reviewer",
      email: "reviewer@example.com",
    };

    const subject = await buildChainAwareSubject(db, reviewId, requester);

    // Must NOT fall through to the base requester (that was fail-OPEN).
    // Must return a chain_step subject.
    expect(subject.kind).toBe("chain_step");

    // And that chain_step subject must deny a reviewer.
    const decision = can(subject as any, ["reviews:decide"]);
    expect(decision.allow).toBe(false);
  });

  it("CLOSE-2: half-state still allows admin (admin bypass is correct, not a hole)", async () => {
    const phantomRunId = "gw_chain_phantom_run11111";
    const phantomStepId = "gw_cstep_phantom_step1111";
    const reviewId = generateId("review");

    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_slug: TEMPLATE_SLUG,
      payload: { content: "half-state-admin" },
      priority: "normal",
      actions: ["approve", "reject"],
      status: "pending",
      chain_run_id: phantomRunId,
      chain_step_id: phantomStepId,
      current_version: 1,
      ladder_index: 0,
    });

    const adminRequester = {
      kind: "session" as const,
      userId: "u_admin_halfstate",
      role: "admin",
      email: "admin@example.com",
    };

    const subject = await buildChainAwareSubject(db, reviewId, adminRequester);
    expect(subject.kind).toBe("chain_step");

    const decision = can(subject as any, ["reviews:decide"]);
    // Admin bypass: even on half-state, admin is still allowed.
    expect(decision.allow).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Step 4: chains:create scope gates POST /chain-runs + /abort
// ────────────────────────────────────────────────────────────────────────────
describe("Chain permission gate — SCOPE: chains:create required", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let fullScopeKey: string;    // has chains:create (from seedTestProject)
  let limitedKey: string;      // has templates:write only — no chains:create

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    fullScopeKey = seed.apiKey;
    await seedTemplates(db, projectId);

    // Seed a limited key with only templates:write
    const rawLimited = "gwk_limited1234567890ab";
    const limitedHash = createHash("sha256").update(rawLimited).digest("hex");
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: projectId,
      key_hash: limitedHash,
      key_prefix: "gwk_limited",
      label: "Limited key (no chains:create)",
      scopes: ["templates:write"],
    });
    limitedKey = rawLimited;

    app = createApp({ db });
  });

  it("SCOPE-1: templates:write-only API key → POST /chain-runs → 403", async () => {
    const res = await request(app)
      .post("/api/v1/chain-runs")
      .set({ Authorization: `Bearer ${limitedKey}` })
      .send(validChainBody());
    expect(res.status).toBe(403);
  });

  it("SCOPE-2: chains:create key → POST /chain-runs → 201", async () => {
    const res = await request(app)
      .post("/api/v1/chain-runs")
      .set({ Authorization: `Bearer ${fullScopeKey}` })
      .send(validChainBody());
    expect(res.status).toBe(201);
  });

  it("SCOPE-3: templates:write-only key → POST /chain-runs/:id/abort → 403 (even before run lookup)", async () => {
    // Create a run with the full-scope key first
    const createRes = await request(app)
      .post("/api/v1/chain-runs")
      .set({ Authorization: `Bearer ${fullScopeKey}` })
      .send(validChainBody());
    expect(createRes.status).toBe(201);
    const runId = createRes.body.id;

    // Attempt abort with limited key → 403 (scope rejected before run lookup)
    const abortRes = await request(app)
      .post(`/api/v1/chain-runs/${runId}/abort`)
      .set({ Authorization: `Bearer ${limitedKey}` });
    expect(abortRes.status).toBe(403);
  });

  it("SCOPE-4: chains:create key → POST /chain-runs/:id/abort → 200", async () => {
    const createRes = await request(app)
      .post("/api/v1/chain-runs")
      .set({ Authorization: `Bearer ${fullScopeKey}` })
      .send(validChainBody());
    expect(createRes.status).toBe(201);
    const runId = createRes.body.id;

    const abortRes = await request(app)
      .post(`/api/v1/chain-runs/${runId}/abort`)
      .set({ Authorization: `Bearer ${fullScopeKey}` });
    expect(abortRes.status).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Step 5: session admin can POST /chain-runs (resolveProjectId fallback)
// ────────────────────────────────────────────────────────────────────────────
describe("Chain permission gate — SADMIN: session admin can create chain runs", () => {
  let app: any;
  let db: any;
  let adminToken: string;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    await seedTemplates(db, seed.project.id);

    // Seed an admin reviewer and mint a JWT (mirrors decide-chain-policy.test.ts pattern)
    const adminId = generateId("user");
    const adminEmail = "admin-sadmin@example.com";
    await db.insert(reviewers).values({
      id: adminId,
      email: adminEmail,
      name: "Admin",
      password_hash: "unused-in-jwt-test",
      role: "admin",
      is_active: true,
    });
    adminToken = jwt.sign(
      { sub: adminId, email: adminEmail },
      config.jwtSecret,
      { audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
    );

    app = createApp({ db });
  });

  it("SADMIN-1: session admin (no projectId) → POST /chain-runs → 201", async () => {
    const res = await request(app)
      .post("/api/v1/chain-runs")
      .set({ Authorization: `Bearer ${adminToken}` })
      .send(validChainBody());
    expect(res.status).toBe(201);
    expect(res.body.object).toBe("chain_run");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Step 6: chain.admin_bypass audit fires when admin decides a chain step
// ────────────────────────────────────────────────────────────────────────────
describe("Chain permission gate — BYPASS: admin_bypass audit event", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let apiKey: string;
  let adminToken: string;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;
    await seedTemplates(db, projectId);

    const adminId = generateId("user");
    const adminEmail = "admin-bypass@example.com";
    await db.insert(reviewers).values({
      id: adminId,
      email: adminEmail,
      name: "Bypass Admin",
      password_hash: "unused-in-jwt-test",
      role: "admin",
      is_active: true,
    });
    adminToken = jwt.sign(
      { sub: adminId, email: adminEmail },
      config.jwtSecret,
      { audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
    );

    app = createApp({ db });
  });

  beforeEach(async () => {
    // Clean state so audit rows don't bleed between tests
    await db.delete(auditLog);
    await db.delete(chainSteps);
    await db.delete(chainRuns);
    await db.delete(reviews);
  });

  it("BYPASS-1: admin deciding a chain step (POST /action) fires chain.admin_bypass audit", async () => {
    // Create a chain run via API key (alice@x.com is assignee for step 1)
    const createRes = await request(app)
      .post("/api/v1/chain-runs")
      .set({ Authorization: `Bearer ${apiKey}` })
      .send(validChainBody());
    expect(createRes.status).toBe(201);
    const step1ReviewId = createRes.body.step_1_review_id;

    // Admin decides (admin is NOT alice@x.com — this is a bypass)
    const actionRes = await request(app)
      .post(`/api/v1/reviews/${step1ReviewId}/action`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ action_id: "approve" });
    expect(actionRes.status).toBe(200);

    // Flush async audit write
    await new Promise((r) => setTimeout(r, 50));

    // chain.admin_bypass audit row must exist
    const bypassRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "chain.admin_bypass"));
    expect(bypassRows.length).toBeGreaterThan(0);
    expect(bypassRows[0].details?.bypass_kind).toBe("admin");
    expect(bypassRows[0].resource_id).toBe(step1ReviewId);
    // Privileged-access rows must be project-scoped, not NULL project_id.
    expect(bypassRows[0].project_id).toBe(projectId);
  });

  it("BYPASS-2: admin deciding via legacy /decide also fires chain.admin_bypass audit", async () => {
    const createRes = await request(app)
      .post("/api/v1/chain-runs")
      .set({ Authorization: `Bearer ${apiKey}` })
      .send(validChainBody());
    expect(createRes.status).toBe(201);
    const step1ReviewId = createRes.body.step_1_review_id;

    const decideRes = await request(app)
      .post(`/api/v1/reviews/${step1ReviewId}/decide`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ decision: "approved" });
    expect(decideRes.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    const bypassRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "chain.admin_bypass"));
    expect(bypassRows.length).toBeGreaterThan(0);
    expect(bypassRows[0].details?.bypass_kind).toBe("admin");
  });

  it("BYPASS-3: non-admin assignee deciding does NOT fire chain.admin_bypass audit", async () => {
    const createRes = await request(app)
      .post("/api/v1/chain-runs")
      .set({ Authorization: `Bearer ${apiKey}` })
      .send(validChainBody());
    expect(createRes.status).toBe(201);
    const step1ReviewId = createRes.body.step_1_review_id;

    // Seed alice (the assignee) and let her decide — no bypass
    const aliceId = generateId("user");
    await db.insert(reviewers).values({
      id: aliceId,
      email: "alice@x.com",
      name: "Alice",
      password_hash: "unused-in-jwt-test",
      role: "reviewer",
      is_active: true,
    });
    const aliceToken = jwt.sign(
      { sub: aliceId, email: "alice@x.com" },
      config.jwtSecret,
      { audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
    );

    const actionRes = await request(app)
      .post(`/api/v1/reviews/${step1ReviewId}/action`)
      .set({ Authorization: `Bearer ${aliceToken}` })
      .send({ action_id: "approve" });
    expect(actionRes.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // No chain.admin_bypass rows
    const bypassRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "chain.admin_bypass"));
    expect(bypassRows.length).toBe(0);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createHash } from "crypto";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import {
  apiKeys,
  projects,
  reviewers,
  templates,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

// Production-readiness audit, P2 / DELTA-2 class regression coverage for
// chain-run GET routes.
//
// Pre-fix, GET /api/v1/chain-runs/:id and GET /api/v1/reviews/:id/chain
// passed `(req as any).projectId || undefined` to engine.getRun /
// getChainContextForReview, and the engine conditionally skipped the
// project filter when the arg was falsy. Session-auth middleware does not
// set req.projectId for these paths, so session callers would have read
// chain-run state across tenants on cloud (multi-project). Benign on OSS
// single-project.
//
// Fix: routes resolve projectId via the resolveProjectId() pattern from
// routes/stats.ts (DELTA-2 closure). engine.getRun and
// engine.getChainContextForReview now require projectId and enforce the
// chain_runs.project_id / reviews.project_id == projectId AND filter.
//
// Regression shape mirrors authz-coverage-delta.test.ts:
//   1) Session in project A → GET chain in project B → 404 (cross-tenant)
//   2) API key in project A → GET chain in project B → 404 (cross-tenant)
//   3) In-project happy path returns the chain
describe("chain-run GET authz — projectId required (B1, DELTA-2 class)", () => {
  let app: any;
  let db: any;
  let projectA: any;
  let projectB: any;
  let templateA: any;
  let templateB: any;
  let chainRunA: { id: string; review_id: string };
  let chainRunB: { id: string; review_id: string };
  let apiKeyA: string;
  let apiKeyB: string;
  let adminSessionB: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;

    // Seed project A — full-scope api key, used to create a chain run.
    const seedA = await seedTestProject(db);
    projectA = seedA.project;
    apiKeyA = seedA.apiKey;

    // Seed project B — separate api key + admin session reviewer for the
    // cross-tenant probe. The admin in B should not be able to read A's
    // chain runs even though they're an admin.
    [projectB] = await db.insert(projects).values({
      id: generateId("project"),
      name: "Project B (chain authz)",
      hmac_secret: "project-b-chain-authz",
    }).returning();

    const rawKeyB = "gwk_chnB01" + Math.random().toString(36).slice(2, 12);
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: projectB.id,
      key_hash: createHash("sha256").update(rawKeyB).digest("hex"),
      key_prefix: rawKeyB.slice(0, 10),
      label: "project-b-chain",
      // Full scopes so we can create + read chains in B for the happy-path
      // assertions. chains:create is required for POST /chain-runs (Task 3
      // BREAKING change — was templates:write).
      scopes: ["chains:create", "templates:write", "templates:read", "reviews:read", "reviews:write"],
    });
    apiKeyB = rawKeyB;

    // Templates in both projects (chain steps reference template slugs).
    [templateA] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "chain_authz_a",
      project_id: projectA.id,
      name: "Chain Authz A",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    }).returning();
    [templateB] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "chain_authz_b",
      project_id: projectB.id,
      name: "Chain Authz B",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    }).returning();

    // Admin reviewer in project B. Without an organization-membership row
    // the session has no explicit project binding — resolveProjectId() falls
    // back to the first project (projects[0]). On OSS that's the test
    // single-project; here we want this admin to resolve to project B so
    // their session "context" is project B. We achieve that by inserting B
    // BEFORE A is recreated... except seedTestProject already inserted A
    // first, so projects[0] == A. To make the cross-tenant probe meaningful
    // we instead use API-key auth for the cross-tenant probe (key in B,
    // request a chain in A) — that's the strongest cross-tenant test.
    //
    // We still seed an admin session for spec-completeness coverage; the
    // session-auth path resolves to project A on OSS (first-project
    // fallback), so the same probe would 404 on a chain in B.
    const hash = await bcrypt.hash("pass123", 10);
    await db.insert(reviewers).values({
      id: generateId("user"),
      email: "admin@chain-authz.local",
      name: "Admin (chain authz)",
      password_hash: hash,
      role: "admin",
    });

    app = createApp({ db });

    const adminLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@chain-authz.local", password: "pass123" });
    adminSessionB = adminLogin.body.token;

    // Create one chain run per project via the public API. POST
    // /chain-runs is the canonical materialisation entry point and sets up
    // the chain_runs + chain_steps + step-1 review row we need for the
    // GET probes.
    const createdA = await request(app).post("/api/v1/chain-runs")
      .set("Authorization", `Bearer ${apiKeyA}`)
      .send({
        definition: {
          version: "1.0",
          mode: "sequential",
          rejection_policy: "terminate",
          steps: [
            { id: "s1", template: "chain_authz_a", assignee: { kind: "user", email: "alice@a.com" } },
          ],
        },
        initial_payload: { content: "A-kickoff" },
      });
    expect(createdA.status).toBe(201);
    chainRunA = { id: createdA.body.id, review_id: createdA.body.step_1_review_id };

    const createdB = await request(app).post("/api/v1/chain-runs")
      .set("Authorization", `Bearer ${apiKeyB}`)
      .send({
        definition: {
          version: "1.0",
          mode: "sequential",
          rejection_policy: "terminate",
          steps: [
            { id: "s1", template: "chain_authz_b", assignee: { kind: "user", email: "bob@b.com" } },
          ],
        },
        initial_payload: { content: "B-kickoff" },
      });
    expect(createdB.status).toBe(201);
    chainRunB = { id: createdB.body.id, review_id: createdB.body.step_1_review_id };
  });

  afterAll(async () => {
    // PGlite client is closed by the next createTestDb() invocation; no
    // teardown needed. Pattern matches authz-coverage-delta.test.ts which
    // also relies on suite-level isolation.
  });

  // Strong cross-tenant probe: API key in project B requesting a chain run
  // owned by project A. Pre-fix, the engine conditionally skipped the
  // project filter on missing projectId — but here projectId IS set (api
  // key auth always sets it). The latent risk is that a future regression
  // could re-introduce the falsy fallthrough; this test pins the engine's
  // strict project filter even on the api-key path.
  it("api key in project B → GET /chain-runs/:id of project A → 404 chain_run_not_found", async () => {
    const res = await request(app)
      .get(`/api/v1/chain-runs/${chainRunA.id}`)
      .set("Authorization", `Bearer ${apiKeyB}`);
    expect(res.status).toBe(404);
    expect(res.body?.error?.code || res.body?.code).toBe("chain_run_not_found");
  });

  it("api key in project B → GET /reviews/:id/chain for review in project A → 404 review_not_in_chain", async () => {
    const res = await request(app)
      .get(`/api/v1/reviews/${chainRunA.review_id}/chain`)
      .set("Authorization", `Bearer ${apiKeyB}`);
    expect(res.status).toBe(404);
    expect(res.body?.error?.code || res.body?.code).toBe("review_not_in_chain");
  });

  // Session-auth probe: session resolves to project A (first-project
  // fallback on OSS — there's no org-membership row pinning this admin to
  // project B). Asking for a chain in project B yields 404 because the
  // engine's project filter rejects it. Pre-fix, session callers reached
  // engine.getRun(runId, undefined) which ran without a project filter and
  // returned project B's chain run.
  it("session in project A (default) → GET /chain-runs/:id of project B → 404 chain_run_not_found", async () => {
    const res = await request(app)
      .get(`/api/v1/chain-runs/${chainRunB.id}`)
      .set("Authorization", `Bearer ${adminSessionB}`);
    expect(res.status).toBe(404);
    expect(res.body?.error?.code || res.body?.code).toBe("chain_run_not_found");
  });

  it("session in project A (default) → GET /reviews/:id/chain for review in project B → 404 review_not_in_chain", async () => {
    const res = await request(app)
      .get(`/api/v1/reviews/${chainRunB.review_id}/chain`)
      .set("Authorization", `Bearer ${adminSessionB}`);
    expect(res.status).toBe(404);
    expect(res.body?.error?.code || res.body?.code).toBe("review_not_in_chain");
  });

  // Happy paths — same project, same auth, returns the chain. Pins that
  // the project-filter doesn't over-reject in-project reads.
  it("api key in project A → GET /chain-runs/:id of project A → 200", async () => {
    const res = await request(app)
      .get(`/api/v1/chain-runs/${chainRunA.id}`)
      .set("Authorization", `Bearer ${apiKeyA}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(chainRunA.id);
  });

  it("session in project A → GET /chain-runs/:id of project A → 200", async () => {
    const res = await request(app)
      .get(`/api/v1/chain-runs/${chainRunA.id}`)
      .set("Authorization", `Bearer ${adminSessionB}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(chainRunA.id);
  });

  // Suppress unused-binding warnings for fixtures kept for traceability.
  void templateA;
  void templateB;
});

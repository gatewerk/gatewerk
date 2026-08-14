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
  reviews,
  templates,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

// Regression coverage for two per-route authz gaps (DELTA 1 + DELTA 2 below).
//
// DELTA 1: `GET /api/v1/templates/:id/stats` (routes/template-stats.ts) was
// authenticated but unauthorized — no `requireScope` gate, no template→project
// ownership check. Any authenticated caller could read template aggregates
// for any template id. Fix: add `requireScope("stats:read")` + project-scoped
// ownership check. Cross-project / cross-tenant metric leak.
//
// DELTA 2: `GET /api/v1/stats` (routes/stats.ts) only applied project scoping
// when `authType === "apikey"`. Session-authed callers received global
// aggregates — benign on OSS single-project, cross-tenant leak on cloud.
//
// Regression shape mirrors the deep-audit exploit suite:
//   1) cross-project / scope-bypass attempt is rejected
//   2) in-project call with the correct scope returns correct aggregates
describe("authz coverage — DELTA 1 (template-stats) + DELTA 2 (stats)", () => {
  let app: any;
  let client: any;
  let db: any;
  let projectA: any;
  let projectB: any;
  let templateA: any;
  let templateB: any;
  let adminSessionA: string;
  let noScopeApiKey: string;
  let statsScopeApiKey: string;
  let apiKeyProjectB: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;

    // Seed A: standard test project + full-scope admin api key.
    const seedA = await seedTestProject(db);
    projectA = seedA.project;

    // Seed B: second project — lets us exercise cross-project leakage.
    [projectB] = await db.insert(projects).values({
      id: generateId("project"),
      name: "Project B",
      hmac_secret: "project-b-hmac-secret",
    }).returning();

    [templateA] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "tpl-a",
      project_id: projectA.id,
      name: "Template A",
      fields: [{ name: "x", type: "text", label: "X", editable: true }],
      actions: ["approve", "reject"],
    }).returning();

    [templateB] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "tpl-b",
      project_id: projectB.id,
      name: "Template B",
      fields: [{ name: "x", type: "text", label: "X", editable: true }],
      actions: ["approve", "reject"],
    }).returning();

    // Seed a review for each project so aggregates have data.
    await db.insert(reviews).values({
      id: generateId("review"),
      project_id: projectA.id,
      template_id: templateA.id,
      template_slug: "tpl-a",
      payload: { x: "A-review" },
    });
    await db.insert(reviews).values({
      id: generateId("review"),
      project_id: projectB.id,
      template_id: templateB.id,
      template_slug: "tpl-b",
      payload: { x: "B-review" },
    });

    // API key in project A without stats:read — used to prove scope gate.
    const rawNoScope = "gwk_nostat01" + Math.random().toString(36).slice(2, 12);
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: projectA.id,
      key_hash: createHash("sha256").update(rawNoScope).digest("hex"),
      key_prefix: rawNoScope.slice(0, 10),
      label: "no-stats-scope",
      scopes: ["audit:read"],
    });
    noScopeApiKey = rawNoScope;

    // API key in project A with stats:read — used to prove happy path.
    const rawStats = "gwk_statsA" + Math.random().toString(36).slice(2, 12);
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: projectA.id,
      key_hash: createHash("sha256").update(rawStats).digest("hex"),
      key_prefix: rawStats.slice(0, 10),
      label: "stats-scope",
      scopes: ["stats:read", "templates:read"],
    });
    statsScopeApiKey = rawStats;

    // API key in project B — used to prove cross-project isolation.
    const rawKeyB = "gwk_projB01" + Math.random().toString(36).slice(2, 12);
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: projectB.id,
      key_hash: createHash("sha256").update(rawKeyB).digest("hex"),
      key_prefix: rawKeyB.slice(0, 10),
      label: "project-b",
      scopes: ["stats:read", "templates:read"],
    });
    apiKeyProjectB = rawKeyB;

    // Admin reviewer session — used to prove session-auth isolation on /stats.
    const hash = await bcrypt.hash("pass123", 10);
    await db.insert(reviewers).values({
      id: generateId("user"),
      email: "admin@authz-delta.local",
      name: "Admin A",
      password_hash: hash,
      role: "admin",
    });

    app = createApp({ db });

    const adminLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@authz-delta.local", password: "pass123" });
    adminSessionA = adminLogin.body.token;
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  // ─── DELTA 1 regression ────────────────────────────────────────────────────

  it("DELTA 1: no-scope api key to /templates/:id/stats is 403", async () => {
    const res = await request(app)
      .get(`/api/v1/templates/${templateA.id}/stats`)
      .set("Authorization", `Bearer ${noScopeApiKey}`);
    expect(res.status).toBe(403);
  });

  it("DELTA 1: cross-project api key to /templates/:id/stats is 404", async () => {
    // Key is for project B, but requests stats on a template owned by project A.
    const res = await request(app)
      .get(`/api/v1/templates/${templateA.id}/stats`)
      .set("Authorization", `Bearer ${apiKeyProjectB}`);
    expect(res.status).toBe(404);
    expect(res.body.code || res.body.error?.code).toBe("template_not_found");
  });

  it("DELTA 1: same-project api key with stats:read returns aggregates", async () => {
    const res = await request(app)
      .get(`/api/v1/templates/${templateA.id}/stats`)
      .set("Authorization", `Bearer ${statsScopeApiKey}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.total_reviews).toBe("number");
    expect(res.body.total_reviews).toBeGreaterThan(0);
  });

  // ─── DELTA 2 regression ────────────────────────────────────────────────────

  it("DELTA 2: session auth /stats is project-scoped — aggregates cover one project, not both", async () => {
    // resolveProjectId() for a session caller returns exactly one project
    // (the active one on cloud, the single OSS project as fallback). The
    // invariant that matters here is "one, not both" — pre-fix, session auth
    // returned aggregates spanning every project in the database.
    const res = await request(app)
      .get("/api/v1/stats")
      .set("Authorization", `Bearer ${adminSessionA}`);
    expect(res.status).toBe(200);
    const slugs = (res.body.by_template || []).map((t: any) => t.template_slug);
    // Exactly one of tpl-a / tpl-b present, never both. Pre-fix this set had
    // two entries (cross-project leak); post-fix it has one.
    const crossProjectSlugs = slugs.filter((s: string) => s === "tpl-a" || s === "tpl-b");
    expect(crossProjectSlugs.length).toBe(1);
    expect(Number(res.body.total)).toBe(1);
  });

  it("DELTA 2: api-key /stats isolates per project", async () => {
    const aRes = await request(app)
      .get("/api/v1/stats")
      .set("Authorization", `Bearer ${statsScopeApiKey}`);
    expect(aRes.status).toBe(200);
    const aSlugs = (aRes.body.by_template || []).map((t: any) => t.template_slug);
    expect(aSlugs).toContain("tpl-a");
    expect(aSlugs).not.toContain("tpl-b");

    const bRes = await request(app)
      .get("/api/v1/stats")
      .set("Authorization", `Bearer ${apiKeyProjectB}`);
    expect(bRes.status).toBe(200);
    const bSlugs = (bRes.body.by_template || []).map((t: any) => t.template_slug);
    expect(bSlugs).toContain("tpl-b");
    expect(bSlugs).not.toContain("tpl-a");
  });
});

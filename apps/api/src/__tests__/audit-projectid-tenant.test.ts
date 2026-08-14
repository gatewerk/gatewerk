import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createHash } from "crypto";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { apiKeys, projects } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { createAuditService } from "../services/audit";

// Production-readiness security audit, Phase 4 B2 cross-tenant regression
// coverage for GET /api/v1/audit.
//
// Pre-fix, audit_log had no project_id column. Any caller with the
// audit:read scope received the entire table — on cloud cutover this would
// have been a cross-org audit log leak. The B2 migration adds project_id +
// the route filters by req.projectId (api key path) or resolveProjectId
// fallback (session path). NULL rows (system-level audit entries with no
// clean project mapping) remain visible to admins as the less restrictive
// default; tightening can land in a follow-up hardening pass.
describe("audit-log GET authz — project_id filter (B2, cloud-readiness)", () => {
  let app: any;
  let auditService: ReturnType<typeof createAuditService>;
  let projectA: any;
  let apiKeyA: string;
  let projectB: any;
  let apiKeyB: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    const db = testDb.db;
    auditService = createAuditService(db);

    const seedA = await seedTestProject(db);
    projectA = seedA.project;
    apiKeyA = seedA.apiKey;

    [projectB] = await db
      .insert(projects)
      .values({
        id: generateId("project"),
        name: "Project B (audit authz)",
        hmac_secret: "project-b-audit-authz",
      })
      .returning();

    const rawKeyB = "gwk_audB01" + Math.random().toString(36).slice(2, 12);
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: projectB.id,
      key_hash: createHash("sha256").update(rawKeyB).digest("hex"),
      key_prefix: rawKeyB.slice(0, 10),
      label: "project-b-audit",
      scopes: ["audit:read"],
    });
    apiKeyB = rawKeyB;

    app = createApp({ db });

    // Seed audit rows: A-tagged, B-tagged, NULL (system-level).
    await auditService.log({
      action: "review.decided",
      actor: "agent:project-a",
      resource_type: "review",
      resource_id: "gw_rev_a_smoke",
      project_id: projectA.id,
      details: { decision: "approved", smoke: true },
    });
    await auditService.log({
      action: "review.decided",
      actor: "agent:project-b",
      resource_type: "review",
      resource_id: "gw_rev_b_smoke",
      project_id: projectB.id,
      details: { decision: "rejected", smoke: true },
    });
    await auditService.log({
      action: "settings.changed",
      actor: "system",
      resource_type: "system",
      resource_id: "boot",
      details: { smoke: true },
      // project_id intentionally omitted — system-level row stays NULL
    });
  });

  it("api key in project A → GET /api/v1/audit → sees only A's rows + NULL system rows", async () => {
    const res = await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${apiKeyA}`);

    expect(res.status).toBe(200);
    const items = res.body.items;
    expect(Array.isArray(items)).toBe(true);

    // Smoke rows only (filtering by details.smoke=true would be pleasant but
    // the route doesn't expose details filter; we check exclusion instead).
    const actorsSeen = new Set(items.map((r: any) => r.actor));
    expect(actorsSeen.has("agent:project-a")).toBe(true);
    expect(actorsSeen.has("agent:project-b")).toBe(false); // <-- the cross-tenant claim
    expect(actorsSeen.has("system")).toBe(true); // NULL-row visibility
  });

  it("api key in project B → GET /api/v1/audit → sees only B's rows + NULL system rows", async () => {
    const res = await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${apiKeyB}`);

    expect(res.status).toBe(200);
    const actorsSeen = new Set(res.body.items.map((r: any) => r.actor));
    expect(actorsSeen.has("agent:project-b")).toBe(true);
    expect(actorsSeen.has("agent:project-a")).toBe(false); // <-- cross-tenant
    expect(actorsSeen.has("system")).toBe(true); // NULL-row visibility
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

// Wave 3 P2 — verifies note.* audit rows carry top-level project_id so the
// tenant-scoped GET /api/v1/audit query returns them.
//
// Pre-fix the notes routes put project_id inside details: only. Top-level
// project_id was NULL, so a note.created row showed up as a "system-level"
// audit entry visible to every project (less restrictive default in
// audit.service.query). Cross-tenant: project A's api key would see
// project B's note.created rows since both rendered as project_id=NULL.
//
// This test covers the create path only — same audit-call shape as the
// other note.* paths (edited/shared/deleted/pinned/unpinned) so a passing
// create case is the canonical smoke. Cross-tenant negative coverage stays
// in audit-projectid-tenant.test.ts (B2 regression suite).
describe("notes audit-log — top-level project_id (Wave 3 P2)", () => {
  let app: any;
  let projectA: any;
  let projectB: any;
  let apiKeyA: string;
  let apiKeyB: string;
  let sessionTokenA: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    const db = testDb.db;

    const seedA = await seedTestProject(db);
    projectA = seedA.project;
    apiKeyA = seedA.apiKey;

    // seedTestProject hardcodes a key prefix that would collide if called
    // twice; mirror it inline for project B.
    const { createHash } = await import("crypto");
    const { ALL_SCOPES } = await import("@gatewerk/shared");
    const { apiKeys, projects } = await import("@gatewerk/db/src/schema/index");
    [projectB] = await db.insert(projects).values({
      id: generateId("project"),
      name: "Project B (audit projectid)",
      hmac_secret: "project-b-audit-projectid",
    }).returning();
    const rawKeyB = "gwk_audP" + Math.random().toString(36).slice(2, 14);
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: projectB.id,
      key_hash: createHash("sha256").update(rawKeyB).digest("hex"),
      key_prefix: rawKeyB.slice(0, 10),
      label: "project-b-key",
      scopes: [...ALL_SCOPES],
    });
    apiKeyB = rawKeyB;

    // Session subject in project A — needed for the private-note path
    // (api_key cannot create private notes per AC #5, write.ts:44). Mirrors
    // notes-crud.test.ts:24-38 setup.
    await db.insert(reviewers).values({
      id: generateId("user"),
      email: "audit-projectid-admin@gatewerk.local",
      name: "Audit Projectid Admin",
      password_hash: await bcrypt.hash("admin123", 10),
      role: "admin",
    });

    app = createApp({ db });

    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "audit-projectid-admin@gatewerk.local", password: "admin123" });
    sessionTokenA = loginRes.body.token;
  });

  it("POST /api/v1/notes (shared) emits a note.created row with top-level project_id", async () => {
    // Create a shared note from project A's api key.
    const create = await request(app)
      .post("/api/v1/notes")
      .set("Authorization", `Bearer ${apiKeyA}`)
      .send({ body: "audit-projectid-smoke", is_shared: true });
    expect(create.status).toBe(201);

    // GET /api/v1/audit from project A — must see the note.created row.
    const a = await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${apiKeyA}`);
    expect(a.status).toBe(200);
    const aRow = a.body.items.find(
      (r: any) => r.action === "note.created" && r.resource_id === create.body.id,
    );
    expect(aRow).toBeDefined();
    // Top-level project_id is the load-bearing assertion.
    expect(aRow.project_id).toBe(projectA.id);
  });

  it("POST /api/v1/notes (private) emits a note.created row with top-level project_id (Wave 6)", async () => {
    // Wave 6: private-note creation must also write a note.created audit
    // row. Pre-fix the `if (is_shared)` gate in write.ts dropped
    // private-note audit entries entirely. The body stays redacted at the
    // read endpoints; metadata (id, project_id, is_shared, tags count) is
    // logged.
    const create = await request(app)
      .post("/api/v1/notes")
      .set("Authorization", `Bearer ${sessionTokenA}`)
      .send({ body: "private-audit-smoke", is_shared: false, project_id: projectA.id });
    expect(create.status).toBe(201);
    expect(create.body.is_shared).toBe(false);

    // GET /api/v1/audit from project A (api_key) — must see the
    // note.created row for the private note.
    const a = await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${apiKeyA}`);
    expect(a.status).toBe(200);
    const aRow = a.body.items.find(
      (r: any) => r.action === "note.created" && r.resource_id === create.body.id,
    );
    expect(aRow).toBeDefined();
    expect(aRow.project_id).toBe(projectA.id);
    // is_shared lands in details so consumers can distinguish private
    // creations from shared ones in the audit timeline.
    expect(aRow.details?.is_shared).toBe(false);
  });

  it("project B cannot see project A's note.created row (cross-tenant)", async () => {
    // Reuse the row created above. Pre-fix this test would FAIL: project_id
    // was NULL on the note.created row, the audit query treats NULL rows as
    // visible-to-all, and project B would see A's note as a "system-level"
    // entry. Post-fix project_id is set, so the project_id WHERE excludes it.
    const b = await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${apiKeyB}`);
    expect(b.status).toBe(200);
    const aNoteIds = b.body.items
      .filter((r: any) => r.action === "note.created")
      .map((r: any) => r.resource_id);
    // None of the note.created rows visible to project B should belong to A.
    for (const id of aNoteIds) {
      // Project B has not created any notes in this test, so any note.created
      // row visible here would be a leak. The set is expected to be empty.
      expect(id).toBeFalsy();
    }
  });
});

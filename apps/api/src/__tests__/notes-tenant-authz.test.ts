import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createHash } from "crypto";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { apiKeys, notes as notesTable, projects } from "@gatewerk/db/src/schema/index";
import { generateId, ALL_SCOPES } from "@gatewerk/shared";

// Wave 1 P1 cross-tenant regression coverage for /api/v1/notes.
//
// Pre-fix:
//   - GET /api/v1/notes used the caller-supplied ?project_id directly in the
//     WHERE. An api_key bound to project A could pass ?project_id=B and read
//     all shared notes from project B.
//   - GET /api/v1/notes/:id selected by id only (with isNull(deleted_at)).
//     Any authenticated caller could read any shared note across the deployment
//     by guessing or knowing its id.
//
// Fix (apps/api/src/routes/notes/read.ts): both handlers now resolve the
// effective project server-side — req.projectId for api_key callers,
// resolveProjectId fallback for session callers — and add eq(project_id, …)
// to the WHERE. api_key callers passing a mismatching ?project_id receive a
// 403 cross_project_forbidden; session callers' ?project_id is ignored. Cross-
// project detail probes return 404 note_not_found (no enumeration leak,
// matches AC #18 admin-private semantics).
//
// Test shape mirrors chain-authz-projectid.test.ts (B1, DELTA-2 class):
// project A + project B, separate api keys, seed a note in each project, then
// probe across the boundary.
describe("notes GET authz — cross-project tenancy (P1 wave 1)", () => {
  let app: any;
  let db: any;
  let projectA: any;
  let projectB: any;
  let apiKeyA: string;
  let apiKeyB: string;
  let sharedNoteA: { id: string };
  let sharedNoteB: { id: string };

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;

    // Project A — full-scope api key from the helper.
    const seedA = await seedTestProject(db);
    projectA = seedA.project;
    apiKeyA = seedA.apiKey;

    // Project B — its own project + full-scope api key. We mirror
    // seedTestProject() inline because the helper only seeds one project per
    // call (it generates a fixed key prefix that would collide).
    [projectB] = await db
      .insert(projects)
      .values({
        id: generateId("project"),
        name: "Project B (notes authz)",
        hmac_secret: "project-b-notes-authz",
      })
      .returning();

    const rawKeyB = "gwk_ntsB01" + Math.random().toString(36).slice(2, 12);
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: projectB.id,
      key_hash: createHash("sha256").update(rawKeyB).digest("hex"),
      key_prefix: rawKeyB.slice(0, 10),
      label: "project-b-notes",
      scopes: [...ALL_SCOPES],
    });
    apiKeyB = rawKeyB;

    app = createApp({ db });

    // Seed one shared note per project. We insert directly to bypass the
    // POST /notes route's project-derivation logic — we want fixtures pinned
    // to known projects, not whichever project the auth header resolves to.
    const idA = generateId("note");
    const idB = generateId("note");
    await db.insert(notesTable).values([
      {
        id: idA,
        project_id: projectA.id,
        author_id: null,
        author_display_fallback: "agent:project-a",
        body: "A-shared-note-secret-content",
        tags: [],
        is_shared: true,
      },
      {
        id: idB,
        project_id: projectB.id,
        author_id: null,
        author_display_fallback: "agent:project-b",
        body: "B-shared-note-secret-content",
        tags: [],
        is_shared: true,
      },
    ]);
    sharedNoteA = { id: idA };
    sharedNoteB = { id: idB };
  });

  // GET /api/v1/notes — list endpoint
  describe("GET /api/v1/notes", () => {
    it("api key in project A → ?project_id=A → sees only A's notes", async () => {
      const res = await request(app)
        .get(`/api/v1/notes?project_id=${projectA.id}`)
        .set("Authorization", `Bearer ${apiKeyA}`);

      expect(res.status).toBe(200);
      const items: any[] = res.body.items;
      expect(items.some((n) => n.id === sharedNoteA.id)).toBe(true);
      expect(items.some((n) => n.id === sharedNoteB.id)).toBe(false);
    });

    it("api key in project A → ?project_id=B → 403 cross_project_forbidden (no leak)", async () => {
      const res = await request(app)
        .get(`/api/v1/notes?project_id=${projectB.id}`)
        .set("Authorization", `Bearer ${apiKeyA}`);

      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe("cross_project_forbidden");
    });

    it("api key in project B → ?project_id=A → 403 cross_project_forbidden (no leak)", async () => {
      const res = await request(app)
        .get(`/api/v1/notes?project_id=${projectA.id}`)
        .set("Authorization", `Bearer ${apiKeyB}`);

      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe("cross_project_forbidden");
    });

    it("api key in project B → ?project_id=B → sees only B's notes", async () => {
      const res = await request(app)
        .get(`/api/v1/notes?project_id=${projectB.id}`)
        .set("Authorization", `Bearer ${apiKeyB}`);

      expect(res.status).toBe(200);
      const items: any[] = res.body.items;
      expect(items.some((n) => n.id === sharedNoteB.id)).toBe(true);
      expect(items.some((n) => n.id === sharedNoteA.id)).toBe(false);
    });
  });

  // GET /api/v1/notes/:id — detail endpoint
  describe("GET /api/v1/notes/:id", () => {
    it("api key in project A → GET note in project A → 200", async () => {
      const res = await request(app)
        .get(`/api/v1/notes/${sharedNoteA.id}`)
        .set("Authorization", `Bearer ${apiKeyA}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(sharedNoteA.id);
      expect(res.body.body).toBe("A-shared-note-secret-content");
    });

    it("api key in project A → GET note in project B → 404 note_not_found (no enumeration leak)", async () => {
      const res = await request(app)
        .get(`/api/v1/notes/${sharedNoteB.id}`)
        .set("Authorization", `Bearer ${apiKeyA}`);

      // 404 not 403 to match AC #18 enumeration-defense semantics: an api_key
      // in project A cannot distinguish "exists in another project" from
      // "doesn't exist" — both surfaces collapse to note_not_found.
      expect(res.status).toBe(404);
      expect(res.body?.error?.code).toBe("note_not_found");
    });

    it("api key in project B → GET note in project A → 404 note_not_found", async () => {
      const res = await request(app)
        .get(`/api/v1/notes/${sharedNoteA.id}`)
        .set("Authorization", `Bearer ${apiKeyB}`);

      expect(res.status).toBe(404);
      expect(res.body?.error?.code).toBe("note_not_found");
    });

    it("api key in project B → GET note in project B → 200", async () => {
      const res = await request(app)
        .get(`/api/v1/notes/${sharedNoteB.id}`)
        .set("Authorization", `Bearer ${apiKeyB}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(sharedNoteB.id);
    });
  });
});

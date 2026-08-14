import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import bcrypt from "bcryptjs";

describe("notes CRUD", () => {
  let app: any;
  let db: any;
  let apiKey: string;
  let sessionToken: string;
  let projectId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    // Admin reviewer for session login (mirrors api-keys.test.ts pattern).
    await db.insert(reviewers).values({
      id: generateId("user"),
      email: "admin@gatewerk.local",
      name: "Admin",
      password_hash: await bcrypt.hash("admin123", 10),
      role: "admin",
    });

    app = createApp({ db });

    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@gatewerk.local", password: "admin123" });

    sessionToken = loginRes.body.token;
  });

  const apiKeyAuth = () => ({ Authorization: `Bearer ${apiKey}` });
  const sessionAuth = () => ({ Authorization: `Bearer ${sessionToken}` });

  describe("POST /api/v1/notes", () => {
    it("session subject creates a private note", async () => {
      const res = await request(app)
        .post("/api/v1/notes")
        .set(sessionAuth())
        .send({ body: "secret", is_shared: false, project_id: projectId });
      expect(res.status).toBe(201);
      expect(res.body.is_shared).toBe(false);
      expect(res.body.body).toBe("secret");
      expect(res.body.id).toMatch(/^gw_nt_/);
    });

    it("session subject creates a shared note with tags", async () => {
      const res = await request(app)
        .post("/api/v1/notes")
        .set(sessionAuth())
        .send({ body: "team", is_shared: true, tags: ["spam-policy"], project_id: projectId });
      expect(res.status).toBe(201);
      expect(res.body.tags).toEqual(["spam-policy"]);
    });

    it("api_key subject CANNOT create private note (AC #5)", async () => {
      const res = await request(app)
        .post("/api/v1/notes")
        .set(apiKeyAuth())
        .send({ body: "x", is_shared: false, project_id: projectId });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toMatch(/api_key.*private|private.*api_key/i);
    });

    it("api_key subject CAN create shared note", async () => {
      const res = await request(app)
        .post("/api/v1/notes")
        .set(apiKeyAuth())
        .send({ body: "agent context", is_shared: true, project_id: projectId });
      expect(res.status).toBe(201);
    });

    it("rejects body > 8KB", async () => {
      const big = "x".repeat(8 * 1024 + 1);
      const res = await request(app)
        .post("/api/v1/notes")
        .set(sessionAuth())
        .send({ body: big, project_id: projectId });
      expect(res.status).toBe(422);
    });
  });

  describe("GET /api/v1/notes", () => {
    it("returns project notes filtered by visibility", async () => {
      const res = await request(app)
        .get(`/api/v1/notes?project_id=${projectId}`)
        .set(sessionAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it("filters by tags", async () => {
      const res = await request(app)
        .get(`/api/v1/notes?project_id=${projectId}&tags=spam-policy`)
        .set(sessionAuth());
      expect(res.status).toBe(200);
      expect(res.body.items.every((n: any) => n.tags.includes("spam-policy"))).toBe(true);
    });

    // Wave 4 P3: total reflects the full filtered count, not page size.
    // Pre-fix total === items.length so any caller paginating saw
    // "total = 3" while has_more=true was lying. Mirrors audit.ts:113.
    it("returns true total when has_more is true", async () => {
      // Seed enough shared notes to overflow a small page. Shared so both
      // session + api_key subjects can see them; project_id locks tenancy.
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post("/api/v1/notes")
          .set(sessionAuth())
          .send({ body: `pagination-seed-${i}`, is_shared: true, project_id: projectId });
      }

      const res = await request(app)
        .get(`/api/v1/notes?project_id=${projectId}&limit=2`)
        .set(sessionAuth());
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBe(2);
      expect(res.body.has_more).toBe(true);
      // The contract: when has_more is true, total must exceed items.length.
      expect(res.body.total).toBeGreaterThan(res.body.items.length);
    });
  });

  describe("GET /api/v1/notes/:id", () => {
    it("returns 404 on nonexistent", async () => {
      const res = await request(app).get("/api/v1/notes/gw_nt_doesnotexist").set(sessionAuth());
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/v1/notes/:id", () => {
    let myNoteId: string;
    let myInitialUpdatedAt: string;

    beforeAll(async () => {
      const res = await request(app)
        .post("/api/v1/notes")
        .set(sessionAuth())
        .send({ body: "v1", is_shared: false, project_id: projectId });
      myNoteId = res.body.id;
      myInitialUpdatedAt = res.body.updated_at;
    });

    it("rejects PATCH with stale updated_at (AC #17)", async () => {
      const stale = "2020-01-01T00:00:00.000Z";
      const res = await request(app)
        .patch(`/api/v1/notes/${myNoteId}`)
        .set(sessionAuth())
        .send({ body: "v2", updated_at: stale });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("stale_updated_at");
    });

    it("mixed PATCH: visibility flip + body edit produces ordered events (AC #11)", async () => {
      // Re-fetch the current note to get its latest updated_at (the AC #17
      // test above did NOT mutate the row, so initial timestamp still valid).
      const get = await request(app).get(`/api/v1/notes/${myNoteId}`).set(sessionAuth());
      const ts = get.body.updated_at;

      const res = await request(app)
        .patch(`/api/v1/notes/${myNoteId}`)
        .set(sessionAuth())
        .send({ body: "v3", is_shared: true, updated_at: ts });
      expect(res.status).toBe(200);
      expect(res.body.is_shared).toBe(true);
      expect(res.body.body).toBe("v3");

      // Audit log assertion — query audit_log for this note's events,
      // ordered by created_at, assert ["note.created", "note.shared",
      // "note.edited"]. Wave 6: note.created now fires for private
      // creations too (write.ts pre-fix was gated on is_shared); the
      // original AC #11 ordering for the PATCH events themselves (shared
      // before edited on a flip+edit transition) is unchanged.
      const { auditLog } = await import("@gatewerk/db/src/schema/index");
      const { eq, asc } = await import("drizzle-orm");
      const events = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, myNoteId))
        .orderBy(asc(auditLog.created_at));
      const actions = events.map((e: any) => e.action);
      expect(actions).toEqual(["note.created", "note.shared", "note.edited"]);
    });
  });

  describe("DELETE /api/v1/notes/:id", () => {
    let adminToken: string;

    beforeAll(async () => {
      const { sessionToken } = await seedReviewer(db, app, {
        email: "second-admin@gatewerk.local",
        role: "admin",
      });
      adminToken = sessionToken;
    });

    it("author can delete own private note", async () => {
      const create = await request(app)
        .post("/api/v1/notes")
        .set(sessionAuth())
        .send({ body: "del me", is_shared: false, project_id: projectId });
      const id = create.body.id;
      const del = await request(app).delete(`/api/v1/notes/${id}`).set(sessionAuth());
      expect(del.status).toBe(204);
    });

    it("admin attempting to delete other-user's private returns 404 (AC #18)", async () => {
      const create = await request(app)
        .post("/api/v1/notes")
        .set(sessionAuth())
        .send({ body: "secret", is_shared: false, project_id: projectId });
      const id = create.body.id;
      const del = await request(app)
        .delete(`/api/v1/notes/${id}`)
        .set({ Authorization: `Bearer ${adminToken}` });
      expect(del.status).toBe(404);
      // Strengthens AC #18: assert generic note_not_found code (admin gets the
      // same response shape as a true-missing note — no enumeration leak).
      // Standalone backstop for the cross-cutting check at
      // notes-visibility-matrix.test.ts:384.
      expect(del.body.error.code).toBe("note_not_found");
    });

    it("admin can delete shared note from another author", async () => {
      const create = await request(app)
        .post("/api/v1/notes")
        .set(sessionAuth())
        .send({ body: "team", is_shared: true, project_id: projectId });
      const id = create.body.id;
      const del = await request(app)
        .delete(`/api/v1/notes/${id}`)
        .set({ Authorization: `Bearer ${adminToken}` });
      expect(del.status).toBe(204);
    });
  });

  describe("GET /api/v1/notes/tags", () => {
    it("returns distinct tags visible in project, sorted ascending", async () => {
      // Seed two notes carrying an overlapping tag so DISTINCT is exercised.
      await request(app)
        .post("/api/v1/notes")
        .set(sessionAuth())
        .send({
          body: "a",
          is_shared: true,
          tags: ["overlap-tag", "alpha-only"],
          project_id: projectId,
        });
      await request(app)
        .post("/api/v1/notes")
        .set(sessionAuth())
        .send({
          body: "b",
          is_shared: true,
          tags: ["overlap-tag", "beta-only"],
          project_id: projectId,
        });

      const res = await request(app)
        .get(`/api/v1/notes/tags?project_id=${projectId}`)
        .set(sessionAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      const items = res.body.items as string[];
      // Distinctness: overlap-tag was applied to two notes, must appear once.
      expect(items.filter((t) => t === "overlap-tag")).toHaveLength(1);
      // Sorted ascending.
      expect([...items].sort()).toEqual(items);
    });
  });
});

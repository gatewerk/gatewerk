import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import {
  notes,
  noteAttachments,
  templates,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

// Task 26 — Parameterized invariant matrix for the note-visibility contract.
//
// Visibility rule (single source of truth: services/notes-visibility.ts):
//   A subject sees a note iff (is_shared = TRUE) OR (author_id = subject.userId).
//   api_key subjects (subject.userId = null) collapse to shared-only.
//   Admin role does NOT bypass: it follows the same OR predicate, so admins see
//   their own private + everyone's shared (Task 18 / AC #18 admin-private 404).
//
// The same predicate is duplicated across 5 read paths today. This matrix
// exercises EVERY path with the SAME 4-note × 4-viewer fixture so any
// regression at any endpoint fails one assertion. Pure regression coverage —
// no production code changes.
//
// Endpoints in the matrix:
//   1. List         GET /api/v1/notes?project_id=...
//   2. Tags         GET /api/v1/notes/tags?project_id=...
//   3. Review detail GET /api/v1/reviews/:id            (inline notes via jsonb_agg)
//   4. Shim         GET /api/v1/reviews/:id/notes       (RFC 8594, session-only)
//   5. Detail       GET /api/v1/notes/:id               (per-(viewer, note) loop)
//
// Stub-then-fix variant: A. The break-and-restore RED snapshot was captured
// by neutralizing noteVisibilityWhere() to `eq(notes.is_shared, true) OR true`
// in a sandbox run before commit; multiple assertions across multiple
// endpoints fail (private notes leak to non-authors). Production code
// restored before staging — `git diff --stat` post-restore is matrix-test-only.

describe("notes visibility — parameterized invariant matrix [Task 26]", () => {
  let app: any;
  let db: any;
  let apiKey: string;
  let projectId: string;
  let reviewId: string;

  // Reviewer subjects (session)
  let userA: { reviewer: any; sessionToken: string };
  let userB: { reviewer: any; sessionToken: string };
  let admin: { reviewer: any; sessionToken: string };

  // Note ids — kept stable so the per-(viewer, noteId) detail loop can
  // index into the expectations table.
  let noteAPrivId: string;
  let noteASharedId: string;
  let noteBPrivId: string;
  let noteBSharedId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    app = createApp({ db });

    // Three session subjects (unique emails per file to avoid PGlite
    // collisions if it ever shares state across files).
    userA = await seedReviewer(db, app, {
      email: "alice@vis-matrix.local",
      role: "reviewer",
      name: "Alice",
    });
    userB = await seedReviewer(db, app, {
      email: "bob@vis-matrix.local",
      role: "reviewer",
      name: "Bob",
    });
    admin = await seedReviewer(db, app, {
      email: "admin@vis-matrix.local",
      role: "admin",
      name: "Admin",
    });

    // Template + a real review pinned to the 4 notes.
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "vis-matrix-tpl",
      project_id: projectId,
      name: "Visibility Matrix Subject",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      default_priority: "normal",
    });
    const r = await request(app)
      .post("/api/v1/reviews")
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({ template: "vis-matrix-tpl", payload: { content: "matrix subject" } });
    reviewId = r.body.id;

    // Direct DB seeding (faster than 4 sequential POSTs and clearer about
    // what's being tested — the read-path visibility filter, not the write
    // path). Mirrors the pattern already used by notes-visibility.test.ts.
    noteAPrivId = generateId("note");
    noteASharedId = generateId("note");
    noteBPrivId = generateId("note");
    noteBSharedId = generateId("note");

    await db.insert(notes).values([
      {
        id: noteAPrivId,
        project_id: projectId,
        author_id: userA.reviewer.id,
        author_display_fallback: null,
        body: "A_private",
        tags: ["a-private"],
        is_shared: false,
      },
      {
        id: noteASharedId,
        project_id: projectId,
        author_id: userA.reviewer.id,
        author_display_fallback: null,
        body: "A_shared",
        tags: ["a-shared"],
        is_shared: true,
      },
      {
        id: noteBPrivId,
        project_id: projectId,
        author_id: userB.reviewer.id,
        author_display_fallback: null,
        body: "B_private",
        tags: ["b-private"],
        is_shared: false,
      },
      {
        id: noteBSharedId,
        project_id: projectId,
        author_id: userB.reviewer.id,
        author_display_fallback: null,
        body: "B_shared",
        tags: ["b-shared"],
        is_shared: true,
      },
    ]);

    await db.insert(noteAttachments).values([
      {
        id: generateId("pin"),
        note_id: noteAPrivId,
        target_kind: "review",
        target_id: reviewId,
        attached_by: userA.reviewer.id,
      },
      {
        id: generateId("pin"),
        note_id: noteASharedId,
        target_kind: "review",
        target_id: reviewId,
        attached_by: userA.reviewer.id,
      },
      {
        id: generateId("pin"),
        note_id: noteBPrivId,
        target_kind: "review",
        target_id: reviewId,
        attached_by: userB.reviewer.id,
      },
      {
        id: generateId("pin"),
        note_id: noteBSharedId,
        target_kind: "review",
        target_id: reviewId,
        attached_by: userB.reviewer.id,
      },
    ]);
  });

  // ----------------------------------------------------------------------
  // Viewer matrix — the 4 subjects whose visibility we're asserting.
  // ----------------------------------------------------------------------
  type Viewer = {
    name: string;
    auth: () => string;
    expectedBodies: string[]; // sorted later
    expectedTags: string[]; // sorted later
    canUseShim: boolean; // false → shim is rejected with 403/session_required
  };

  // Lazy auth() so tokens minted in beforeAll resolve at call time.
  const viewers = (): Viewer[] => [
    {
      name: "userA",
      auth: () => `Bearer ${userA.sessionToken}`,
      expectedBodies: ["A_private", "A_shared", "B_shared"],
      expectedTags: ["a-private", "a-shared", "b-shared"],
      canUseShim: true,
    },
    {
      name: "userB",
      auth: () => `Bearer ${userB.sessionToken}`,
      expectedBodies: ["A_shared", "B_private", "B_shared"],
      expectedTags: ["a-shared", "b-private", "b-shared"],
      canUseShim: true,
    },
    {
      name: "admin",
      auth: () => `Bearer ${admin.sessionToken}`,
      expectedBodies: ["A_shared", "B_shared"],
      expectedTags: ["a-shared", "b-shared"],
      canUseShim: true,
    },
    {
      name: "api_key",
      auth: () => `Bearer ${apiKey}`,
      expectedBodies: ["A_shared", "B_shared"],
      expectedTags: ["a-shared", "b-shared"],
      canUseShim: false, // shim is session-only
    },
  ];

  // ----------------------------------------------------------------------
  // 1. LIST endpoint — GET /api/v1/notes
  // ----------------------------------------------------------------------
  describe("GET /api/v1/notes (list)", () => {
    for (const v of viewers()) {
      it(`${v.name} sees only visible note bodies`, async () => {
        const res = await request(app)
          .get(`/api/v1/notes?project_id=${projectId}`)
          .set("Authorization", v.auth());
        expect(res.status).toBe(200);
        const bodies = res.body.items.map((n: any) => n.body).sort();
        expect(bodies).toEqual(v.expectedBodies.slice().sort());
      });
    }
  });

  // ----------------------------------------------------------------------
  // 2. TAGS endpoint — GET /api/v1/notes/tags
  // ----------------------------------------------------------------------
  describe("GET /api/v1/notes/tags", () => {
    for (const v of viewers()) {
      it(`${v.name} sees only tags from visible notes`, async () => {
        const res = await request(app)
          .get(`/api/v1/notes/tags?project_id=${projectId}`)
          .set("Authorization", v.auth());
        expect(res.status).toBe(200);
        const tags = (res.body.items as string[]).slice().sort();
        expect(tags).toEqual(v.expectedTags.slice().sort());
      });
    }
  });

  // ----------------------------------------------------------------------
  // 3. REVIEW DETAIL endpoint — GET /api/v1/reviews/:id  (inline notes)
  // ----------------------------------------------------------------------
  describe("GET /api/v1/reviews/:id (inline notes)", () => {
    for (const v of viewers()) {
      it(`${v.name} sees only visible note bodies in inline notes[]`, async () => {
        const res = await request(app)
          .get(`/api/v1/reviews/${reviewId}`)
          .set("Authorization", v.auth());
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.notes)).toBe(true);
        const bodies = res.body.notes.map((n: any) => n.body).sort();
        expect(bodies).toEqual(v.expectedBodies.slice().sort());
      });
    }
  });

  // ----------------------------------------------------------------------
  // 4. SHIM endpoint — GET /api/v1/reviews/:id/notes  (legacy, session-only)
  //
  // Shim returns shared-only regardless of viewer (it filters
  // is_shared = TRUE in SQL, no per-author union). So every session viewer
  // sees the same 2 bodies. api_key is rejected at auth — surfaces as 401
  // /authentication_error, NOT the 403 /session_required path. The
  // ForbiddenError("Session auth required for legacy shim", "session_required")
  // branch in routes/reviews/notes.ts:147 is unreachable on this GET handler
  // because `req.reviewer` is unset for api_key auth (set only by the
  // session-auth middleware), so the earlier `if (!reviewer)` guard at
  // line 139 throws AuthenticationError first. From the visibility
  // contract's perspective this is fine: api_key gets zero notes from the
  // shim either way. Surface the discrepancy here so a future tidy can
  // either remove the dead 403 branch or re-route api_key through it.
  // ----------------------------------------------------------------------
  describe("GET /api/v1/reviews/:id/notes (shim, legacy shape)", () => {
    const SHIM_SHARED_ONLY = ["A_shared", "B_shared"];

    for (const v of viewers()) {
      if (v.canUseShim) {
        it(`${v.name} sees only shared note contents (shim is shared-only)`, async () => {
          const res = await request(app)
            .get(`/api/v1/reviews/${reviewId}/notes`)
            .set("Authorization", v.auth());
          expect(res.status).toBe(200);
          const contents = res.body.items
            .map((n: any) => n.content)
            .sort();
          expect(contents).toEqual(SHIM_SHARED_ONLY.slice().sort());
        });
      } else {
        it(`${v.name} is rejected at auth (401, no leak)`, async () => {
          const res = await request(app)
            .get(`/api/v1/reviews/${reviewId}/notes`)
            .set("Authorization", v.auth());
          // The visibility-contract assertion: api_key gets nothing from
          // the shim. Status is 401 (auth path), not the 403 the route
          // handler's later branch documents — see comment block above.
          expect(res.status).toBe(401);
          expect(res.body?.items).toBeUndefined();
        });
      }
    }
  });

  // ----------------------------------------------------------------------
  // 5. DETAIL endpoint — GET /api/v1/notes/:id  (per-(viewer, note) loop)
  //
  // For each (viewer × noteId), assert the expected status + body. Private
  // notes return 404 to non-authors (admin-private 404 contract from
  // routes/notes/read.ts: "Private + non-author → 404 not 403, to avoid
  // enumeration leak"). Admins are NOT exempt — confirmed by re-reading
  // read.ts:91 — the predicate is `row.author_id !== subjectUser`, role-blind.
  // ----------------------------------------------------------------------
  describe("GET /api/v1/notes/:id (detail per-note)", () => {
    type DetailExpectation = { status: number; body?: string };

    // Build the expectations table in a beforeAll-friendly way: ids are
    // closed over from the outer scope at it() time.
    const detailExpectations = (): Record<string, Record<string, DetailExpectation>> => ({
      userA: {
        [noteAPrivId]: { status: 200, body: "A_private" }, // own private
        [noteASharedId]: { status: 200, body: "A_shared" }, // own shared
        [noteBPrivId]: { status: 404 }, // other-author private → 404
        [noteBSharedId]: { status: 200, body: "B_shared" }, // shared
      },
      userB: {
        [noteAPrivId]: { status: 404 },
        [noteASharedId]: { status: 200, body: "A_shared" },
        [noteBPrivId]: { status: 200, body: "B_private" },
        [noteBSharedId]: { status: 200, body: "B_shared" },
      },
      admin: {
        // Admin gets 404 on private notes — admin role does NOT bypass
        // the visibility filter (read.ts:91 is role-blind).
        [noteAPrivId]: { status: 404 },
        [noteASharedId]: { status: 200, body: "A_shared" },
        [noteBPrivId]: { status: 404 },
        [noteBSharedId]: { status: 200, body: "B_shared" },
      },
      api_key: {
        [noteAPrivId]: { status: 404 },
        [noteASharedId]: { status: 200, body: "A_shared" },
        [noteBPrivId]: { status: 404 },
        [noteBSharedId]: { status: 200, body: "B_shared" },
      },
    });

    // (label, idGetter) pairs — labels are static literals so vitest's
    // reporter shows distinct test names. Ids are resolved at it() body
    // time (after beforeAll has populated them).
    const noteCases: Array<{ label: string; getId: () => string }> = [
      { label: "noteA_private", getId: () => noteAPrivId },
      { label: "noteA_shared", getId: () => noteASharedId },
      { label: "noteB_private", getId: () => noteBPrivId },
      { label: "noteB_shared", getId: () => noteBSharedId },
    ];

    for (const v of viewers()) {
      describe(`viewer=${v.name}`, () => {
        for (const c of noteCases) {
          it(`fetch ${c.label} → expected status + body`, async () => {
            const id = c.getId();
            const expected = detailExpectations()[v.name][id];
            const res = await request(app)
              .get(`/api/v1/notes/${id}`)
              .set("Authorization", v.auth());
            expect(res.status).toBe(expected.status);
            if (expected.status === 200) {
              expect(res.body.body).toBe(expected.body);
              expect(res.body.id).toBe(id);
            } else if (expected.status === 404) {
              expect(res.body?.error?.code).toBe("note_not_found");
            }
          });
        }

        // Sanity: ensure ids resolved correctly (catches a beforeAll
        // ordering regression that would silently skip the assertions).
        it("note ids resolved from beforeAll", () => {
          for (const c of noteCases) {
            expect(c.getId()).toMatch(/^gw_nt_/);
          }
        });
      });
    }
  });

  // ----------------------------------------------------------------------
  // M2 (Phase 3 review): 401-unauthenticated smoke. Every read path's
  // subjectFromRequest guard is exercised. A regression that flips one of
  // these (e.g., a refactor that lets `subject` resolve to a partial truthy
  // shape on missing/invalid Authorization) would silently grant
  // unauthenticated access. Today only the shim api_key case at line 310
  // asserted a 401; this loop closes the gap across all 5 read paths.
  // ----------------------------------------------------------------------
  describe("401 unauthenticated smoke (M2)", () => {
    const ENDPOINTS = [
      { name: "list", path: () => `/api/v1/notes?project_id=${projectId}` },
      { name: "detail", path: () => `/api/v1/notes/${noteASharedId}` },
      { name: "tags", path: () => `/api/v1/notes/tags?project_id=${projectId}` },
      { name: "review-detail", path: () => `/api/v1/reviews/${reviewId}` },
      { name: "shim", path: () => `/api/v1/reviews/${reviewId}/notes` },
    ];

    for (const endpoint of ENDPOINTS) {
      it(`${endpoint.name} rejects unauthenticated requests with 401`, async () => {
        // No Authorization header — should never reach the handler logic.
        const res = await request(app).get(endpoint.path());
        expect(res.status).toBe(401);
      });
    }
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import {
  notes,
  noteAttachments,
  templates,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

/**
 * Per-target cap enforcement [AC #16, #16b].
 *
 * AC #16:  51st SHARED note pinned to ONE target → 409 target_cap.
 * AC #16b: 51st PRIVATE note pinned to ONE target by SAME author → 409 target_cap.
 *
 * Each scenario uses an isolated reviewId so seeded counts don't cross-pollute
 * the other branch.
 */
describe("notes per-target cap", () => {
  let app: any;
  let db: any;
  let apiKey: string;
  let sessionToken: string;
  let authorUserId: string;
  let projectId: string;
  let reviewIdShared: string;
  let reviewIdPrivate: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    app = createApp({ db });

    const reviewer = await seedReviewer(db, app, {
      email: "cap-author@gatewerk.local",
      role: "reviewer",
    });
    sessionToken = reviewer.sessionToken;
    authorUserId = reviewer.reviewer.id;

    // Template for review creation.
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "test-review",
      project_id: projectId,
      name: "Test Review",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      default_priority: "normal",
    });

    // Two distinct reviews so seeded shared-cap counts don't pollute the
    // private-per-author seeding below.
    const r1 = await request(app)
      .post("/api/v1/reviews")
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({ template: "test-review", payload: { content: "shared target" } });
    reviewIdShared = r1.body.id;

    const r2 = await request(app)
      .post("/api/v1/reviews")
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({ template: "test-review", payload: { content: "private target" } });
    reviewIdPrivate = r2.body.id;
  });

  const auth = () => ({ Authorization: `Bearer ${sessionToken}` });

  describe("AC #16: shared cap", () => {
    beforeAll(async () => {
      // Direct DB inserts — 50 SHARED notes pinned to reviewIdShared.
      // Skipping HTTP round-trips keeps the suite fast.
      for (let i = 0; i < 50; i++) {
        const noteId = generateId("note");
        await db.insert(notes).values({
          id: noteId,
          project_id: projectId,
          author_id: authorUserId,
          author_display_fallback: null,
          body: `seed-shared-${i}`,
          tags: [],
          is_shared: true,
        });
        await db.insert(noteAttachments).values({
          id: generateId("pin"),
          note_id: noteId,
          target_kind: "review",
          target_id: reviewIdShared,
          attached_by: authorUserId,
        });
      }
    });

    it("AC #16: 51st shared note pinned to one target returns 409 target_cap", async () => {
      const res = await request(app)
        .post("/api/v1/notes")
        .set(auth())
        .send({
          body: "overflow-shared",
          is_shared: true,
          project_id: projectId,
          attachments: [{ target_kind: "review", target_id: reviewIdShared }],
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("target_cap");
    });
  });

  describe("AC #16b: private-per-author cap", () => {
    beforeAll(async () => {
      // Direct DB inserts — 50 PRIVATE notes pinned to reviewIdPrivate by the
      // SAME author. AC #5 forbids api_key creating private, so seeded notes
      // belong to the session reviewer.
      for (let i = 0; i < 50; i++) {
        const noteId = generateId("note");
        await db.insert(notes).values({
          id: noteId,
          project_id: projectId,
          author_id: authorUserId,
          author_display_fallback: null,
          body: `seed-private-${i}`,
          tags: [],
          is_shared: false,
        });
        await db.insert(noteAttachments).values({
          id: generateId("pin"),
          note_id: noteId,
          target_kind: "review",
          target_id: reviewIdPrivate,
          attached_by: authorUserId,
        });
      }
    });

    it("AC #16b: 51st private note pinned to one target by same author returns 409 target_cap", async () => {
      const res = await request(app)
        .post("/api/v1/notes")
        .set(auth())
        .send({
          body: "overflow-private",
          is_shared: false,
          project_id: projectId,
          attachments: [{ target_kind: "review", target_id: reviewIdPrivate }],
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("target_cap");
    });
  });

  // M5: POST /notes that creates a note + multiple attachments must be
  // transactional. If the second attachment trips the per-target cap, the
  // first attachment AND the note row must roll back — otherwise we leave
  // an orphan note (and partial attachment) in the DB and the client gets
  // 409 with no way to tell what survived.
  describe("M5: transactional POST /notes rollback on cap rejection", () => {
    let reviewIdM5: string;

    beforeAll(async () => {
      // Fresh review so its target-cap counter is independent of the other
      // describe blocks above.
      const r = await request(app)
        .post("/api/v1/reviews")
        .set({ Authorization: `Bearer ${apiKey}` })
        .send({ template: "test-review", payload: { content: "m5 target" } });
      reviewIdM5 = r.body.id;

      // Pre-populate cap to 49: the second attachment in our 2-attachment
      // POST will trip the cap (49 → 50 ok on first → 51 trips on second).
      for (let i = 0; i < 49; i++) {
        const noteId = generateId("note");
        await db.insert(notes).values({
          id: noteId,
          project_id: projectId,
          author_id: authorUserId,
          author_display_fallback: null,
          body: `m5-seed-${i}`,
          tags: [],
          is_shared: true,
        });
        await db.insert(noteAttachments).values({
          id: generateId("pin"),
          note_id: noteId,
          target_kind: "review",
          target_id: reviewIdM5,
          attached_by: authorUserId,
        });
      }
    });

    it("M5: POST /notes with 2 attachments where the 2nd trips cap rolls back the note + 1st attachment", async () => {
      const bodyMarker = "m5-rollback-marker-uniq";

      const res = await request(app)
        .post("/api/v1/notes")
        .set(auth())
        .send({
          body: bodyMarker,
          is_shared: true,
          project_id: projectId,
          attachments: [
            { target_kind: "review", target_id: reviewIdM5 },
            { target_kind: "review", target_id: reviewIdM5 },
          ],
        });

      // Cap rejection on the 2nd attachment.
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("target_cap");

      // No `notes` row with our marker body should exist (transaction rolled back).
      const noteRows = await db
        .select()
        .from(notes)
        .where(eq(notes.body, bodyMarker));
      expect(noteRows.length).toBe(0);

      // No `note_attachments` rows beyond the 49 pre-seeded should exist.
      const attRows = await db
        .select()
        .from(noteAttachments)
        .where(
          and(
            eq(noteAttachments.target_kind, "review"),
            eq(noteAttachments.target_id, reviewIdM5),
          ),
        );
      expect(attRows.length).toBe(49);
    });
  });
});

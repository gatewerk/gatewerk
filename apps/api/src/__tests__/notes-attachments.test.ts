import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { notes, projects, apiKeys, templates } from "@gatewerk/db/src/schema/index";
import { generateId, ALL_SCOPES } from "@gatewerk/shared";
import { createHash } from "crypto";

describe("notes attachments — pin/unpin [AC #12]", () => {
  let app: any;
  let db: any;
  let apiKey: string;
  let sessionToken: string;
  let projectId: string;
  let reviewId: string;
  let noteId: string;
  let secondProjectReviewId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    app = createApp({ db });

    // Mint a session token for note-author identity
    const { sessionToken: stoken } = await seedReviewer(db, app, {
      email: "pin-author@gatewerk.local",
      role: "reviewer",
    });
    sessionToken = stoken;

    // Need a template in project 1 for review creation (seedTestProject does
    // not seed any template).
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "test-review",
      project_id: projectId,
      name: "Test Review",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      default_priority: "normal",
    });

    // Real review in project 1
    const r = await request(app).post("/api/v1/reviews")
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({ template: "test-review", payload: { content: "Hi" } });
    reviewId = r.body.id;

    // Shared note created via session
    const n = await request(app).post("/api/v1/notes")
      .set({ Authorization: `Bearer ${sessionToken}` })
      .send({ body: "n1", is_shared: true, project_id: projectId });
    noteId = n.body.id;

    // Second project + review (for cross-project AC #12 test)
    const secondProjectId = generateId("project");
    await db.insert(projects).values({
      id: secondProjectId,
      name: "Second Project",
      hmac_secret: "second-hmac-secret",
    });
    const secondKeyRaw = "gwk_test_other_project_xyz";
    const secondKeyHash = createHash("sha256").update(secondKeyRaw).digest("hex");
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: secondProjectId,
      key_hash: secondKeyHash,
      key_prefix: "gwk_test",
      label: "Second project key",
      scopes: [...ALL_SCOPES],
    });
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "test-review",
      project_id: secondProjectId,
      name: "Test Review (second project)",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      default_priority: "normal",
    });
    const secondReview = await request(app).post("/api/v1/reviews")
      .set({ Authorization: `Bearer ${secondKeyRaw}` })
      .send({ template: "test-review", payload: { content: "Other" } });
    secondProjectReviewId = secondReview.body.id;
  });

  const auth = () => ({ Authorization: `Bearer ${sessionToken}` });

  it("pins to a real review", async () => {
    const res = await request(app)
      .post(`/api/v1/notes/${noteId}/attachments`)
      .set(auth())
      .send({ target_kind: "review", target_id: reviewId });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^gw_pin_/);
    expect(res.body.target_kind).toBe("review");
    expect(res.body.target_id).toBe(reviewId);
  });

  it("rejects pin to nonexistent review with 404 (AC #12)", async () => {
    const res = await request(app)
      .post(`/api/v1/notes/${noteId}/attachments`)
      .set(auth())
      .send({ target_kind: "review", target_id: "gw_rev_doesnotexist" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("target_not_found");
  });

  it("rejects pin to cross-project review with 404 (AC #12)", async () => {
    const res = await request(app)
      .post(`/api/v1/notes/${noteId}/attachments`)
      .set(auth())
      .send({ target_kind: "review", target_id: secondProjectReviewId });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("target_not_found");
  });

  // M1: soft-deleted note must not be re-attachable. The DELETE /notes/:id
  // path tombstones via deleted_at; the attachment POST handler must filter
  // tombstoned rows out of its lookup so a stale client cannot pin new
  // attachments after delete.
  it("M1: rejects pin on soft-deleted note with 404 note_not_found", async () => {
    // Create a fresh note, then directly tombstone it (skip DELETE route to
    // keep this test pinned to the attachment-route filter under test).
    const n = await request(app)
      .post("/api/v1/notes")
      .set(auth())
      .send({ body: "soft-delete-pin", is_shared: true, project_id: projectId });
    const softDeletedNoteId = n.body.id;

    await db.update(notes).set({ deleted_at: new Date() }).where(eq(notes.id, softDeletedNoteId));

    const res = await request(app)
      .post(`/api/v1/notes/${softDeletedNoteId}/attachments`)
      .set(auth())
      .send({ target_kind: "review", target_id: reviewId });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("note_not_found");
  });

  // M2: same filter on the unpin path. Without it, a soft-deleted note's
  // existing attachments would still expose an unpin surface (404 path needs
  // to come from note-not-found, not from attachment-not-found, to match the
  // POST behavior and avoid surprising clients).
  it("M2: rejects unpin on soft-deleted note with 404 note_not_found", async () => {
    // Create a note, attach it to reviewId, then tombstone the note.
    const n = await request(app)
      .post("/api/v1/notes")
      .set(auth())
      .send({ body: "soft-delete-unpin", is_shared: true, project_id: projectId });
    const targetNoteId = n.body.id;

    const att = await request(app)
      .post(`/api/v1/notes/${targetNoteId}/attachments`)
      .set(auth())
      .send({ target_kind: "review", target_id: reviewId });
    expect(att.status).toBe(201);
    const attachmentId = att.body.id;

    await db.update(notes).set({ deleted_at: new Date() }).where(eq(notes.id, targetNoteId));

    const res = await request(app)
      .delete(`/api/v1/notes/${targetNoteId}/attachments/${attachmentId}`)
      .set(auth());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("note_not_found");
  });

  // Double-pin: the same (note, target) pair pinned twice races past the
  // route's own checks (neither the per-target cap nor any existence check
  // rejects a duplicate) and lands on the note_attachments_unique constraint.
  // That must come back as a clean 409, not a 500 — see lib/pg-error.ts.
  it("rejects double-pin of the same note to the same target with 409 already_attached", async () => {
    const n = await request(app)
      .post("/api/v1/notes")
      .set(auth())
      .send({ body: "double-pin", is_shared: true, project_id: projectId });
    const targetNoteId = n.body.id;

    const first = await request(app)
      .post(`/api/v1/notes/${targetNoteId}/attachments`)
      .set(auth())
      .send({ target_kind: "review", target_id: reviewId });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/v1/notes/${targetNoteId}/attachments`)
      .set(auth())
      .send({ target_kind: "review", target_id: reviewId });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("already_attached");
  });
});

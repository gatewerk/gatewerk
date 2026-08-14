import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { deleteWithNoteAttachments, runOrphanGc } from "../services/note-cleanup";
import {
  notes,
  noteAttachments,
  reviews,
  templates,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

/**
 * AC #14: Deleting a target row (review/template/chain_run) cascades its
 * note_attachments rows, but the underlying notes row is preserved.
 *
 * The deleteWithNoteAttachments helper is the contract — every hard-delete
 * call site for a target table routes through it so polymorphic FK rows
 * never orphan.
 */
describe("note-attachments cascade on target delete (AC #14)", () => {
  let app: any;
  let db: any;
  let apiKey: string;
  let sessionToken: string;
  let projectId: string;
  let reviewId: string;
  let templateId: string;
  let reviewNoteId: string;
  let templateNoteId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    app = createApp({ db });

    const { sessionToken: stoken } = await seedReviewer(db, app, {
      email: "cleanup-author@gatewerk.local",
      role: "reviewer",
    });
    sessionToken = stoken;

    // Seed a template for review creation
    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "cleanup-tmpl",
      project_id: projectId,
      name: "Cleanup template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      default_priority: "normal",
    }).returning();
    templateId = tpl.id;

    // Create a review via the API
    const r = await request(app).post("/api/v1/reviews")
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({ template: "cleanup-tmpl", payload: { content: "cleanup-test" } });
    reviewId = r.body.id;

    // Pin a shared note to the review
    const reviewNote = await request(app).post("/api/v1/notes")
      .set({ Authorization: `Bearer ${sessionToken}` })
      .send({
        body: "review-attached note",
        is_shared: true,
        project_id: projectId,
        attachments: [{ target_kind: "review", target_id: reviewId }],
      });
    reviewNoteId = reviewNote.body.id;

    // Pin a separate shared note to the template
    const templateNote = await request(app).post("/api/v1/notes")
      .set({ Authorization: `Bearer ${sessionToken}` })
      .send({
        body: "template-attached note",
        is_shared: true,
        project_id: projectId,
        attachments: [{ target_kind: "template", target_id: templateId }],
      });
    templateNoteId = templateNote.body.id;
  });

  it("AC #14: deleteWithNoteAttachments(db, 'review', id) removes the review row and its note_attachments, but preserves the note", async () => {
    // Sanity: the attachment row exists pre-delete
    const preAtts = await db
      .select()
      .from(noteAttachments)
      .where(and(
        eq(noteAttachments.target_kind, "review"),
        eq(noteAttachments.target_id, reviewId),
      ));
    expect(preAtts).toHaveLength(1);

    await deleteWithNoteAttachments(db, "review", reviewId);

    // The reviews row is gone
    const remainingReviews = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId));
    expect(remainingReviews).toHaveLength(0);

    // The note_attachments row is gone (cascade)
    const remainingAtts = await db
      .select()
      .from(noteAttachments)
      .where(and(
        eq(noteAttachments.target_kind, "review"),
        eq(noteAttachments.target_id, reviewId),
      ));
    expect(remainingAtts).toHaveLength(0);

    // The note itself is PRESERVED — notes outlive their attachments
    const note = await db
      .select()
      .from(notes)
      .where(eq(notes.id, reviewNoteId));
    expect(note).toHaveLength(1);
    expect(note[0].body).toBe("review-attached note");
  });

  it("AC #14: deleteWithNoteAttachments(db, 'template', id) cascades attachments and preserves the note", async () => {
    const preAtts = await db
      .select()
      .from(noteAttachments)
      .where(and(
        eq(noteAttachments.target_kind, "template"),
        eq(noteAttachments.target_id, templateId),
      ));
    expect(preAtts).toHaveLength(1);

    await deleteWithNoteAttachments(db, "template", templateId);

    const remainingTemplates = await db
      .select()
      .from(templates)
      .where(eq(templates.id, templateId));
    expect(remainingTemplates).toHaveLength(0);

    const remainingAtts = await db
      .select()
      .from(noteAttachments)
      .where(and(
        eq(noteAttachments.target_kind, "template"),
        eq(noteAttachments.target_id, templateId),
      ));
    expect(remainingAtts).toHaveLength(0);

    const note = await db
      .select()
      .from(notes)
      .where(eq(notes.id, templateNoteId));
    expect(note).toHaveLength(1);
    expect(note[0].body).toBe("template-attached note");
  });
});

/**
 * AC #15: nightly orphan GC removes note_attachments rows whose
 * (target_kind, target_id) no longer match an existing target row. Notes
 * themselves are NEVER touched. Valid attachments — those whose target still
 * exists — are also untouched.
 *
 * The GC is the third defense layer for the cascade contract:
 *   1. deleteWithNoteAttachments helper (Task 21) — single-row deletes
 *   2. gatewerk/no-bare-target-delete eslint rule (Task 22) — prevents new
 *      bare deletes
 *   3. Nightly orphan GC (this) — catches services/reviews/bulk.ts:bulkDelete
 *      (deliberately bare per Task 21) plus any future delete site that
 *      bypasses both layers above
 *
 * This describe block uses its own isolated testDb so the AC #14 deletes
 * (which remove the seeded review + template) don't pollute selectivity
 * fixtures here.
 */
describe("runOrphanGc — AC #15", () => {
  let db: any;
  let app: any;
  let apiKey: string;
  let sessionToken: string;
  let projectId: string;
  let validReviewId: string;
  let validAttId: string;
  let orphanNoteId: string;
  let orphanAttId: string;
  let validNoteId: string;
  let authorId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    app = createApp({ db });

    const { reviewer, sessionToken: stoken } = await seedReviewer(db, app, {
      email: "gc-author@gatewerk.local",
      role: "reviewer",
    });
    sessionToken = stoken;
    authorId = reviewer.id;

    // Seed a template + a real review so the valid-attachment fixture has a
    // live target.
    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "gc-tmpl",
      project_id: projectId,
      name: "GC template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      default_priority: "normal",
    }).returning();

    const r = await request(app).post("/api/v1/reviews")
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({ template: "gc-tmpl", payload: { content: "gc-test" } });
    validReviewId = r.body.id;

    // Pin a shared note to the LIVE review (this attachment must survive GC).
    const validNote = await request(app).post("/api/v1/notes")
      .set({ Authorization: `Bearer ${sessionToken}` })
      .send({
        body: "valid attachment note",
        is_shared: true,
        project_id: projectId,
        attachments: [{ target_kind: "review", target_id: validReviewId }],
      });
    validNoteId = validNote.body.id;

    // Look up the valid attachment id so we can assert preservation.
    const [validAtt] = await db
      .select()
      .from(noteAttachments)
      .where(and(
        eq(noteAttachments.target_kind, "review"),
        eq(noteAttachments.target_id, validReviewId),
      ));
    validAttId = validAtt.id;

    // Seed an ORPHAN attachment directly via SQL — note exists, target_id
    // points at a review id that does not exist anywhere. This is the row
    // GC must remove.
    orphanNoteId = generateId("note");
    await db.insert(notes).values({
      id: orphanNoteId,
      project_id: projectId,
      author_id: authorId,
      author_display_fallback: null,
      body: "orphan test note",
      tags: [],
      is_shared: true,
    });
    orphanAttId = generateId("pin");
    await db.insert(noteAttachments).values({
      id: orphanAttId,
      note_id: orphanNoteId,
      target_kind: "review",
      target_id: "gw_rev_doesntexistanywhere",
      attached_by: null,
    });
  });

  it("AC #15: removes attachment rows whose target no longer exists", async () => {
    // Pre-condition: orphan attachment exists.
    const preOrphan = await db
      .select()
      .from(noteAttachments)
      .where(eq(noteAttachments.id, orphanAttId));
    expect(preOrphan).toHaveLength(1);

    const removed = await runOrphanGc(db);

    expect(removed).toBe(1);

    // Orphan attachment is gone.
    const orphanLeft = await db
      .select()
      .from(noteAttachments)
      .where(eq(noteAttachments.id, orphanAttId));
    expect(orphanLeft).toHaveLength(0);

    // Note itself preserved (notes outlive their attachments).
    const noteStill = await db
      .select()
      .from(notes)
      .where(eq(notes.id, orphanNoteId));
    expect(noteStill).toHaveLength(1);

    // Valid attachment preserved (selectivity check — GC must not sweep too
    // broadly).
    const validLeft = await db
      .select()
      .from(noteAttachments)
      .where(eq(noteAttachments.id, validAttId));
    expect(validLeft).toHaveLength(1);

    // Valid note also preserved.
    const validNoteStill = await db
      .select()
      .from(notes)
      .where(eq(notes.id, validNoteId));
    expect(validNoteStill).toHaveLength(1);
  });

  it("AC #15: returns 0 and is a no-op when no orphans exist", async () => {
    // Idempotency check: running again after the orphan was swept should
    // find nothing.
    const removed = await runOrphanGc(db);
    expect(removed).toBe(0);

    // Valid attachment still there.
    const validLeft = await db
      .select()
      .from(noteAttachments)
      .where(eq(noteAttachments.id, validAttId));
    expect(validLeft).toHaveLength(1);
  });
});

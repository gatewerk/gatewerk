import { describe, it, expect, beforeAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db";
import {
  projects,
  reviews,
  reviewNotes,
  notes,
  noteAttachments,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

/**
 * AC #19: Migration 027 backfill regression coverage.
 *
 * Mirrors the backfill SQL from `packages/db/migrations/027-notes-layer.sql`
 * steps 3 + 4 verbatim (with one PGlite-specific substitution noted below).
 * Seeds legacy state in PGlite — project + review + a `review_notes` row —
 * then runs the backfill SQL and asserts the resulting `notes` row +
 * `note_attachments` row match the shape the migration is contracted to
 * produce.
 *
 * The legacy `review_notes` table is NOT dropped by 027 (drop deferred to
 * v1.4 cleanup), so this test exists to catch regressions if the backfill
 * SQL is ever re-edited or the cleanup migration accidentally re-applies
 * it incorrectly.
 *
 * --- PGlite gen_random_bytes substitution ---
 * The production migration generates pin ids via:
 *   'gw_pin_' || translate(encode(gen_random_bytes(18), 'base64'), '+/=', '-_')
 *
 * `gen_random_bytes` lives in pgcrypto, which PGlite does not enable in our
 * test harness. The test substitutes `md5(random()::text)` to produce a
 * 32-char hex suffix that satisfies the same shape contract (id starts with
 * "gw_pin_", is non-null, is unique per row). The assertions below check
 * shape, not exact format, so this substitution is contract-equivalent for
 * regression-coverage purposes.
 */

const STEP_3_BACKFILL_SQL = `
  INSERT INTO notes (
    id, project_id, author_id, author_display_fallback, body, is_shared, created_at, updated_at
  )
  SELECT
    rn.id,
    r.project_id,
    NULL,
    rn.author,
    rn.content,
    TRUE,
    rn.created_at,
    rn.created_at
  FROM review_notes rn
  JOIN reviews r ON r.id = rn.review_id
  ON CONFLICT (id) DO NOTHING;
`;

// PGlite substitution: md5(random()::text) replaces gen_random_bytes(18)+base64
// to sidestep the missing pgcrypto extension. Shape contract unchanged.
const STEP_4_BACKFILL_SQL = `
  INSERT INTO note_attachments (
    id, note_id, target_kind, target_id, attached_by, attached_at
  )
  SELECT
    'gw_pin_' || md5(random()::text),
    rn.id,
    'review',
    rn.review_id,
    NULL,
    rn.created_at
  FROM review_notes rn
  WHERE NOT EXISTS (
    SELECT 1 FROM note_attachments na
    WHERE na.note_id = rn.id AND na.target_kind = 'review' AND na.target_id = rn.review_id
  );
`;

describe("migration 027 backfill — AC #19", () => {
  let db: any;
  const projectId = generateId("project");
  const reviewId = generateId("review");
  const legacyNoteId = generateId("note");
  const legacyNoteAuthor = "Original Author <orig@example.com>";
  const legacyBody = "legacy body content";

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;

    // Seed minimal legacy state: project + review + review_notes row.
    await db.insert(projects).values({
      id: projectId,
      name: "migration-test",
      hmac_secret: "test-hmac",
    });

    await db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_slug: "test-tmpl",
      payload: { content: "test" },
    });

    await db.insert(reviewNotes).values({
      id: legacyNoteId,
      review_id: reviewId,
      author: legacyNoteAuthor,
      content: legacyBody,
    });

    // Run both backfill steps verbatim (modulo the gen_random_bytes
    // substitution documented above).
    await db.execute(sql.raw(STEP_3_BACKFILL_SQL));
    await db.execute(sql.raw(STEP_4_BACKFILL_SQL));
  });

  it("AC #19: backfills review_notes -> notes preserving id/project/body/author/is_shared", async () => {
    const [migratedNote] = await db
      .select()
      .from(notes)
      .where(eq(notes.id, legacyNoteId));

    expect(migratedNote).toBeDefined();
    expect(migratedNote.id).toBe(legacyNoteId);                        // gw_nt_ id preserved verbatim
    expect(migratedNote.project_id).toBe(projectId);                   // inherited via JOIN reviews
    expect(migratedNote.author_id).toBeNull();                         // legacy author was display string
    expect(migratedNote.author_display_fallback).toBe(legacyNoteAuthor);
    expect(migratedNote.body).toBe(legacyBody);
    expect(migratedNote.is_shared).toBe(true);                         // legacy notes were team-visible
  });

  it("AC #19: backfills note_attachments — every legacy note pinned to its original review", async () => {
    const [migratedAtt] = await db
      .select()
      .from(noteAttachments)
      .where(eq(noteAttachments.note_id, legacyNoteId));

    expect(migratedAtt).toBeDefined();
    expect(migratedAtt.target_kind).toBe("review");
    expect(migratedAtt.target_id).toBe(reviewId);
    expect(migratedAtt.attached_by).toBeNull();                        // pinner unknown for legacy rows
    expect(migratedAtt.id).toMatch(/^gw_pin_/);                        // pin id shape contract
  });

  it("AC #19: backfill is idempotent — re-running does not duplicate rows", async () => {
    // Re-run both backfill steps. ON CONFLICT DO NOTHING (notes) and
    // WHERE NOT EXISTS (attachments) must keep this safe.
    await db.execute(sql.raw(STEP_3_BACKFILL_SQL));
    await db.execute(sql.raw(STEP_4_BACKFILL_SQL));

    const noteCountRows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(notes)
      .where(eq(notes.id, legacyNoteId));
    expect(noteCountRows[0].c).toBe(1);

    const attCountRows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(noteAttachments)
      .where(eq(noteAttachments.note_id, legacyNoteId));
    expect(attCountRows[0].c).toBe(1);
  });
});

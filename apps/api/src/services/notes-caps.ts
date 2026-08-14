import { and, count, eq, isNull } from "drizzle-orm";
import { notes, noteAttachments } from "@gatewerk/db/src/schema/index";
import { ConflictError } from "@gatewerk/shared";
import type { NoteTargetKind } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";

/**
 * Per-target attachment cap (spec §6.4 / AC #16, #16b).
 *
 * Two distinct buckets per target:
 *   - SHARED: at most 50 shared notes pinned to a given target.
 *   - PRIVATE: at most 50 private notes pinned to a given target PER AUTHOR.
 *
 * Buckets are independent so one author's private graffiti can't crowd out
 * shared team context, and one author's seeding can't deny-of-service another
 * author's private cap.
 *
 * Caller must invoke this BEFORE inserting a new note_attachments row.
 */
const PER_TARGET_CAP = 50;

export async function enforcePerTargetCap(
  db: AppDb,
  ctx: {
    target_kind: NoteTargetKind;
    target_id: string;
    is_shared: boolean;
    author_id: string | null;
  },
): Promise<void> {
  if (ctx.is_shared) {
    const rows = await db
      .select({ c: count() })
      .from(noteAttachments)
      .innerJoin(notes, eq(notes.id, noteAttachments.note_id))
      .where(
        and(
          eq(noteAttachments.target_kind, ctx.target_kind),
          eq(noteAttachments.target_id, ctx.target_id),
          eq(notes.is_shared, true),
          isNull(notes.deleted_at),
        ),
      );
    const c = rows[0]?.c ?? 0;
    if (c >= PER_TARGET_CAP) {
      throw new ConflictError(
        `target has ${PER_TARGET_CAP} shared note attachments`,
        "target_cap",
      );
    }
    return;
  }

  // M6: AC #5 invariant — private notes always have an author_id (api_key
  // callers are rejected before reaching this branch, see write.ts §6.3).
  // The "__null__" sentinel below would silently bypass the cap if author_id
  // were NULL (every NULL author would share one bucket and the cap would
  // partition on a fictional "__null__" identity). Throw explicitly here so
  // a future refactor that breaks AC #5 surfaces as a 500 server error
  // rather than a silent fail-open.
  if (ctx.author_id == null) {
    throw new Error("enforcePerTargetCap: private branch reached with null author_id (violates AC #5)");
  }

  // Private branch — count is partitioned by author so each author has their
  // own 50-cap.
  const rows = await db
    .select({ c: count() })
    .from(noteAttachments)
    .innerJoin(notes, eq(notes.id, noteAttachments.note_id))
    .where(
      and(
        eq(noteAttachments.target_kind, ctx.target_kind),
        eq(noteAttachments.target_id, ctx.target_id),
        eq(notes.is_shared, false),
        eq(notes.author_id, ctx.author_id),
        isNull(notes.deleted_at),
      ),
    );
  const c = rows[0]?.c ?? 0;
  if (c >= PER_TARGET_CAP) {
    throw new ConflictError(
      `target has ${PER_TARGET_CAP} private note attachments for this author`,
      "target_cap",
    );
  }
}

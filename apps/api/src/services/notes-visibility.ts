import { and, eq, isNull, or, desc } from "drizzle-orm";
import { notes } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";

/**
 * Single source of truth for note visibility.
 *
 * A subject sees a note iff it is shared OR they authored it. `subject_user_id`
 * is null for api_key subjects — they only see shared.
 *
 * Every read path that surfaces note bodies MUST go through this predicate
 * (or the parameterized inline subquery in spec section 7.4 which uses the
 * same logic). Defense in depth: serializer redaction in Task 8 catches the
 * case where a query forgets to apply the filter.
 */
export function noteVisibilityWhere(subject_user_id: string | null) {
  if (subject_user_id == null) {
    return eq(notes.is_shared, true);
  }
  return or(eq(notes.is_shared, true), eq(notes.author_id, subject_user_id));
}

export async function listNotesForSubject(
  db: AppDb,
  params: { project_id: string; subject_user_id: string | null }
) {
  const rows = await db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.project_id, params.project_id),
        isNull(notes.deleted_at),
        noteVisibilityWhere(params.subject_user_id)
      )
    )
    .orderBy(desc(notes.created_at));
  return rows;
}

/**
 * Defense-in-depth body redaction at the response boundary.
 *
 * Even if a query forgets to apply `noteVisibilityWhere`, this serializer-level
 * redaction blanks the body of private notes that don't belong to the subject.
 * Body-only — `id`, `tags`, `is_shared`, `author_id`, etc. are preserved.
 */
export function redactPrivateBody<T extends { body: string; is_shared: boolean; author_id: string | null }>(
  note: T,
  ctx: { subject_user_id: string | null }
): T {
  if (note.is_shared) return note;
  if (note.author_id != null && ctx.subject_user_id === note.author_id) return note;
  return { ...note, body: "" };
}

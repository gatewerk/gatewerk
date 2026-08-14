import { Router } from "express";
import { and, arrayOverlaps, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { notes, noteAttachments } from "@gatewerk/db/src/schema/index";
import {
  ListNotesQuerySchema,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from "@gatewerk/shared";
import { validate } from "../../middleware/validate";
import { subjectFromRequest } from "../../policy/subjects";
import { resolveProjectId } from "../../lib/resolve-project-id";
import { noteVisibilityWhere, redactPrivateBody } from "../../services/notes-visibility";
import type { NotesRouteDeps } from "./_deps";

export function createNotesReadRoutes(deps: NotesRouteDeps): Router {
  const router = Router();
  const { db } = deps;

  router.get("/", validate({ query: ListNotesQuerySchema }), async (req, res, next) => {
    try {
      const subject = subjectFromRequest(req);
      if (!subject) throw new AuthenticationError("Authentication required");
      const q = req.query as any;
      const subjectUser = subject.kind === "session" ? subject.userId : null;

      // The schema accepts a caller-supplied `project_id`, but using it
      // directly in the WHERE lets
      // an api_key in project A read shared notes from project B by passing
      // ?project_id=B. Resolve the authoritative project server-side instead
      // — req.projectId for api_key callers, resolveProjectId fallback for
      // session callers (mirrors routes/audit.ts:34, routes/stats.ts).
      //
      // Behavior:
      //   - api_key caller passes a mismatching ?project_id → 403 (loud — they
      //     are deliberately referencing another tenant).
      //   - session caller's ?project_id is ignored; the resolver picks the
      //     OSS first-project default. Pre-cloud, sessions are always single-
      //     project, so this is observably equivalent to the old behavior
      //     when the caller passes their own project; it strips the latent
      //     cross-tenant capability.
      const effectiveProjectId =
        (req as any).projectId ?? (await resolveProjectId(req, db));
      if (!effectiveProjectId) {
        throw new NotFoundError("Project not found", "project_not_found");
      }
      if (
        subject.kind === "api_key" &&
        q.project_id &&
        q.project_id !== effectiveProjectId
      ) {
        throw new ForbiddenError(
          "api_key cannot read notes from another project",
          "cross_project_forbidden",
        );
      }

      // attached_to_kind / attached_to_id filter via a correlated EXISTS
      // against note_attachments. Inbox NotesSection passes
      // attached_to_kind=review + attached_to_id=<reviewId> expecting
      // review-scoped notes. EXISTS keeps the row count stable (no JOIN
      // multiplication) and lets the existing total/has_more pagination
      // work unchanged.
      // has_attachments=true → EXISTS any attachment for this note.
      // has_attachments=false → NOT EXISTS any attachment.
      const attachedFilter =
        q.attached_to_kind || q.attached_to_id
          ? sql`EXISTS (
              SELECT 1 FROM ${noteAttachments} na
              WHERE na.note_id = ${notes.id}
              ${q.attached_to_kind ? sql`AND na.target_kind = ${q.attached_to_kind}` : sql``}
              ${q.attached_to_id ? sql`AND na.target_id = ${q.attached_to_id}` : sql``}
            )`
          : undefined;
      const hasAttachmentsFilter =
        q.has_attachments === true
          ? sql`EXISTS (SELECT 1 FROM ${noteAttachments} na WHERE na.note_id = ${notes.id})`
          : q.has_attachments === false
          ? sql`NOT EXISTS (SELECT 1 FROM ${noteAttachments} na WHERE na.note_id = ${notes.id})`
          : undefined;

      const where = and(
        eq(notes.project_id, effectiveProjectId),
        isNull(notes.deleted_at),
        noteVisibilityWhere(subjectUser),
        q.author_id ? eq(notes.author_id, q.author_id) : undefined,
        q.is_shared !== undefined ? eq(notes.is_shared, q.is_shared) : undefined,
        q.tags?.length ? arrayOverlaps(notes.tags, q.tags) : undefined,
        attachedFilter,
        hasAttachmentsFilter,
      );

      // items + count run in parallel against the same `where` predicate.
      // `total` must come from a real count query, not `items.length` —
      // otherwise `has_more=true` pages report the page size instead of
      // the result set size to any caller computing page-count or
      // progress meters off the total.
      const itemsPromise = db
        .select()
        .from(notes)
        .where(where)
        .orderBy(desc(notes.created_at))
        .limit(q.limit + 1);

      const countPromise = db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(notes)
        .where(where);

      const [rows, countRows] = await Promise.all([itemsPromise, countPromise]);
      const total = countRows[0]?.count ?? 0;

      const hasMore = rows.length > q.limit;
      const slice = hasMore ? rows.slice(0, q.limit) : rows;

      // Bulk-load attachments for the listed notes — single query, no N+1.
      const ids = slice.map((n) => n.id);
      const atts = ids.length
        ? await db
            .select()
            .from(noteAttachments)
            .where(inArray(noteAttachments.note_id, ids))
        : [];
      const byNote = new Map<string, any[]>();
      for (const a of atts) {
        const arr = byNote.get(a.note_id) ?? [];
        arr.push(a);
        byNote.set(a.note_id, arr);
      }

      // Defense in depth: redactPrivateBody at the response boundary
      // even though the visibility filter should have excluded private
      // notes the subject isn't authorized to see.
      const items = slice.map((n) =>
        redactPrivateBody(
          { ...n, attachments: byNote.get(n.id) ?? [] },
          { subject_user_id: subjectUser },
        ),
      );

      res.json({ items, total, has_more: hasMore });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const subject = subjectFromRequest(req);
      if (!subject) throw new AuthenticationError("Authentication required");
      const subjectUser = subject.kind === "session" ? subject.userId : null;

      // Without the project_id filter, a caller could read any shared note
      // in the deployment by id.
      // Resolve effective project the same way as the LIST handler and
      // include it in the SELECT predicate. Cross-project hits return the
      // same `note_not_found` 404 as truly-missing rows (no enumeration leak,
      // matches AC #18 admin-private semantics).
      const effectiveProjectId =
        (req as any).projectId ?? (await resolveProjectId(req, db));
      if (!effectiveProjectId) {
        throw new NotFoundError("Note not found", "note_not_found");
      }

      const [row] = await db
        .select()
        .from(notes)
        .where(
          and(
            eq(notes.id, String(req.params.id)),
            eq(notes.project_id, effectiveProjectId),
            isNull(notes.deleted_at),
          ),
        );

      if (!row) {
        throw new NotFoundError("Note not found", "note_not_found");
      }

      // Private + non-author → 404 not 403, to avoid enumeration leak (AC #18-style).
      if (!row.is_shared && row.author_id !== subjectUser) {
        throw new NotFoundError("Note not found", "note_not_found");
      }

      const atts = await db
        .select()
        .from(noteAttachments)
        .where(eq(noteAttachments.note_id, row.id));

      res.json(
        redactPrivateBody({ ...row, attachments: atts }, { subject_user_id: subjectUser }),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}

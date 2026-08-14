import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  notes,
  noteAttachments,
  reviewers,
  reviews as reviewsTable,
} from "@gatewerk/db/src/schema/index";
import {
  AuthenticationError,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  generateId,
  ReviewNoteBodySchema,
} from "@gatewerk/shared";
import { validate } from "../../middleware/validate";
import { rateLimitByKey } from "../../middleware/rate-limit-key";
import { resolveProjectId } from "../../lib/resolve-project-id";
import type { ReviewRouteDeps } from "./_deps";

// Task 18 — RFC 8594 deprecation shim for /api/v1/reviews/:id/notes.
// Legacy handlers used to write to the deprecated `review_notes` table
// directly. Phase A's notes-layer migration backfilled those rows into
// `notes` + `note_attachments` (preserving `gw_nt_` IDs), so the shim
// now reads/writes the new tables but preserves the legacy
// {id, review_id, author, content, created_at} response shape so existing
// API consumers (n8n nodes, SDKs, ComposeBar pre-Task 20) keep working
// through the deprecation window.
//
// The Sunset placeholder (Sat, 31 Dec 2026 23:59:59 GMT) is the v1.4
// release lock target per spec §11.8 — not yet committed; tighten when
// v1.4 ships.
//
// M3: applied as middleware BEFORE validate() so 422 validation failures
// also carry the deprecation signal. Inline calls inside the handler are
// bypassed when validate() short-circuits on a Zod error.
function deprecationHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", "Sat, 31 Dec 2026 23:59:59 GMT");
  res.setHeader("Link", '</api/v1/notes>; rel="successor-version"');
  next();
}

export function createReviewNotesRoutes(deps: ReviewRouteDeps): Router {
  const router = Router();
  const { db, auditService } = deps;

  // POST /api/v1/reviews/:id/notes — legacy shim writing into notes +
  // note_attachments. Returns the legacy {id, review_id, author, content,
  // created_at} shape so existing API consumers keep working during the
  // deprecation window. rateLimitByKey() retained so shim mutations stay
  // rate-bound for api_key callers.
  router.post(
    "/:id/notes",
    rateLimitByKey(),
    deprecationHeaders,
    validate({ body: ReviewNoteBodySchema }),
    async (req, res, next) => {
      try {
        const reviewer = (req as any).reviewer;
        if (!reviewer) throw new AuthenticationError("Authentication required");

        const reviewId = String(req.params.id);
        const projectId = await resolveProjectId(req, db, reviewId);
        if (!projectId) throw new NotFoundError("Review not found", "review_not_found");

        // Confirm the review exists in the resolved project. resolveProjectId
        // already looked the review up by id, but only returned project_id —
        // re-select to make the cross-project guard explicit.
        const [review] = await db
          .select({ id: reviewsTable.id })
          .from(reviewsTable)
          .where(
            and(eq(reviewsTable.id, reviewId), eq(reviewsTable.project_id, projectId)),
          );
        if (!review) throw new NotFoundError("Review not found", "review_not_found");

        const content = String(req.body?.content ?? "").trim();
        if (!content) {
          throw new InvalidRequestError("content is required", "content", "content_required");
        }

        const author = reviewer.name || reviewer.email || reviewer.id;
        const noteId = generateId("note");
        const attId = generateId("pin");
        const now = new Date();

        await db.insert(notes).values({
          id: noteId,
          project_id: projectId,
          author_id: reviewer.id,
          author_display_fallback: null,
          body: content,
          tags: [],
          is_shared: true,
          created_at: now,
          updated_at: now,
        });
        await db.insert(noteAttachments).values({
          id: attId,
          note_id: noteId,
          target_kind: "review",
          target_id: reviewId,
          attached_by: reviewer.id,
          attached_at: now,
        });

        if (auditService) {
          await auditService.log({
            action: "note.created",
            actor: reviewer.id,
            resource_type: "note",
            resource_id: noteId,
            details: {
              project_id: projectId,
              via_shim: true,
              review_id: reviewId,
            },
          });
        }

        res.status(201).json({
          id: noteId,
          review_id: reviewId,
          author,
          content,
          created_at: now.toISOString(),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/v1/reviews/:id/notes — legacy shim reading from notes +
  // note_attachments via 3-way drizzle typed builder (no raw db.execute,
  // matches Task 17 GET /tags rationale: postgres-js / PGlite shape
  // divergence on raw queries).
  router.get("/:id/notes", deprecationHeaders, async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      if (!reviewer) throw new AuthenticationError("Authentication required");
      // Although the legacy POST guard above relies on session-set
      // req.reviewer, an api_key surface could theoretically reach here.
      // Force session-only to match the /api/v1/notes write path and
      // avoid surprising the audit (`actor` would otherwise be ambiguous).
      // resolveProjectId still respects req.projectId on api_key auth, but
      // there is no reviewer identity to attach to the legacy shape.
      if (!reviewer.id) {
        throw new ForbiddenError("Session auth required for legacy shim", "session_required");
      }

      const reviewId = String(req.params.id);
      const projectId = await resolveProjectId(req, db, reviewId);
      if (!projectId) throw new NotFoundError("Review not found", "review_not_found");

      const rows = await db
        .select({
          id: notes.id,
          body: notes.body,
          created_at: notes.created_at,
          author_id: notes.author_id,
          author_display_fallback: notes.author_display_fallback,
          reviewer_name: reviewers.name,
          reviewer_email: reviewers.email,
        })
        .from(notes)
        .innerJoin(noteAttachments, eq(noteAttachments.note_id, notes.id))
        .leftJoin(reviewers, eq(reviewers.id, notes.author_id))
        .where(
          and(
            eq(notes.project_id, projectId),
            eq(noteAttachments.target_kind, "review"),
            eq(noteAttachments.target_id, reviewId),
            eq(notes.is_shared, true),
            isNull(notes.deleted_at),
          ),
        )
        .orderBy(desc(notes.created_at));

      const items = rows.map((r) => ({
        id: r.id,
        review_id: reviewId,
        author:
          r.reviewer_name ??
          r.reviewer_email ??
          r.author_display_fallback ??
          r.author_id ??
          "Unknown",
        content: r.body,
        created_at:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : String(r.created_at),
      }));

      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

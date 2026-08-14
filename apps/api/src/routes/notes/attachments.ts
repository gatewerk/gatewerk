import { Router } from "express";
import { and, count, eq, isNull } from "drizzle-orm";
import { notes, noteAttachments, reviews, templates, chainRuns } from "@gatewerk/db/src/schema/index";
import {
  generateId,
  PinNoteBodySchema,
  AuthenticationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  NOTE_ATTACHMENTS_MAX,
} from "@gatewerk/shared";
import { validate } from "../../middleware/validate";
import { rateLimitByKey } from "../../middleware/rate-limit-key";
import { isAdminSubject, subjectFromRequest } from "../../policy/subjects";
import { enforcePerTargetCap } from "../../services/notes-caps";
import { isUniqueViolation } from "../../lib/pg-error";
import type { NotesRouteDeps } from "./_deps";

const TARGET_TABLES: Record<string, any> = {
  review: reviews,
  template: templates,
  chain_run: chainRuns,
};

export function createNotesAttachmentRoutes(deps: NotesRouteDeps): Router {
  const router = Router();
  const { db, auditService } = deps;

  // rateLimitByKey() on attachment mutations, matching the /reviews mutation
  // routes and the /notes write routes. No-op for session callers; per-key
  // bucket for api_key callers.
  router.post("/:id/attachments", rateLimitByKey(), validate({ body: PinNoteBodySchema }), async (req, res, next) => {
    try {
      const subject = subjectFromRequest(req);
      if (!subject) throw new AuthenticationError("Authentication required");
      const subjectUser = subject.kind === "session" ? subject.userId : null;

      const [note] = await db.select().from(notes).where(
        and(eq(notes.id, String(req.params.id)), isNull(notes.deleted_at)),
      );
      if (!note) throw new NotFoundError("Note not found", "note_not_found");
      if (!note.is_shared && note.author_id !== subjectUser) {
        throw new NotFoundError("Note not found", "note_not_found");
      }

      const { target_kind, target_id } = req.body as import("@gatewerk/shared").PinNoteBody;

      // AC #12: target must exist AND share the note's project_id.
      // Cross-project pin attempts return 404 with the same code as nonexistent
      // (no enumeration leak about resources in other projects).
      const table = TARGET_TABLES[target_kind];
      const [target] = await db
        .select({ id: table.id, project_id: table.project_id })
        .from(table)
        .where(eq(table.id, target_id));
      if (!target || target.project_id !== note.project_id) {
        throw new NotFoundError("Target not found", "target_not_found");
      }

      // Per-note attachment cap (10).
      const attCount = await db
        .select({ c: count() })
        .from(noteAttachments)
        .where(eq(noteAttachments.note_id, note.id));
      if ((attCount[0]?.c ?? 0) >= NOTE_ATTACHMENTS_MAX) {
        throw new ConflictError(
          `note has ${NOTE_ATTACHMENTS_MAX} attachments`,
          "attachment_cap",
        );
      }

      await enforcePerTargetCap(db, {
        target_kind,
        target_id,
        is_shared: note.is_shared,
        author_id: note.author_id,
      });

      const attId = generateId("pin");
      try {
        await db.insert(noteAttachments).values({
          id: attId,
          note_id: note.id,
          target_kind,
          target_id,
          attached_by: subjectUser,
        });
      } catch (err) {
        // Two concurrent pins of the same (note, target) pair race past the
        // per-target cap check above and land on the table's own unique
        // constraint. Read through drizzle's DrizzleQueryError wrapper — see
        // lib/pg-error.ts. Deliberately unnamed: this constraint has two live
        // names depending on how the DB was provisioned — Postgres
        // auto-generates `note_attachments_note_id_target_kind_target_id_key`
        // from the unnamed inline UNIQUE in migrations/027-notes-layer.sql on
        // an incrementally-migrated install, while a fresh install bootstrapped
        // from packages/db/scripts/baseline.sql gets the drizzle-declared
        // `note_attachments_unique`. note_attachments has exactly one business
        // unique constraint, so an unnamed 23505 here is unambiguous.
        if (isUniqueViolation(err)) {
          throw new ConflictError("Note is already attached to this target", "already_attached");
        }
        throw err;
      }

      if (note.is_shared) {
        await auditService.log({
          action: "note.pinned",
          actor: subjectUser ?? "api_key",
          resource_type: "note",
          resource_id: note.id,
          // Wave 3 P2: top-level project_id for tenant-scoped audit query.
          project_id: note.project_id,
          details: { target_kind, target_id },
        });
      }

      res.status(201).json({
        id: attId,
        target_kind,
        target_id,
        attached_by: subjectUser,
        attached_at: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id/attachments/:attId", rateLimitByKey(), async (req, res, next) => {
    try {
      const subject = subjectFromRequest(req);
      if (!subject || subject.kind !== "session") {
        throw new AuthenticationError("Session required");
      }
      const subjectUser = subject.userId;
      const isAdmin = isAdminSubject(subject);

      const [att] = await db.select().from(noteAttachments).where(eq(noteAttachments.id, String(req.params.attId)));
      if (!att || att.note_id !== String(req.params.id)) {
        throw new NotFoundError("Attachment not found", "attachment_not_found");
      }
      const [note] = await db.select().from(notes).where(
        and(eq(notes.id, att.note_id), isNull(notes.deleted_at)),
      );
      if (!note) throw new NotFoundError("Note not found", "note_not_found");

      const isPinner = att.attached_by === subjectUser;
      const isAuthor = note.author_id === subjectUser;
      if (!isPinner && !isAuthor && !isAdmin) {
        throw new ForbiddenError("Not authorized to unpin", "not_authorized");
      }

      await db.delete(noteAttachments).where(eq(noteAttachments.id, att.id));

      if (note.is_shared) {
        await auditService.log({
          action: "note.unpinned",
          actor: subjectUser,
          resource_type: "note",
          resource_id: note.id,
          // Wave 3 P2: top-level project_id for tenant-scoped audit query.
          project_id: note.project_id,
          details: { target_kind: att.target_kind, target_id: att.target_id },
        });
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

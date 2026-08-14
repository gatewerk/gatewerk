import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { notes, noteAttachments } from "@gatewerk/db/src/schema/index";
import {
  generateId,
  CreateNoteBodySchema,
  PatchNoteBodySchema,
  GatewerkError,
  InvalidRequestError,
  AuthenticationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from "@gatewerk/shared";
import { validate } from "../../middleware/validate";
import { rateLimitByKey } from "../../middleware/rate-limit-key";
import { isAdminSubject, subjectFromRequest } from "../../policy/subjects";
import { enforcePerTargetCap } from "../../services/notes-caps";
import type { NotesRouteDeps } from "./_deps";

export function createNotesWriteRoutes(deps: NotesRouteDeps): Router {
  const router = Router();
  const { db, auditService } = deps;

  // rateLimitByKey() on every mutation. No-op for session callers (no
  // apiKeyId); api_key callers get the per-key per-hour bucket already
  // used by /reviews/:id/notes shim, the chains routes, and reviews
  // mutating endpoints. Match those for parity.
  router.post("/", rateLimitByKey(), validate({ body: CreateNoteBodySchema }), async (req, res, next) => {
    try {
      const subject = subjectFromRequest(req);
      if (!subject) throw new AuthenticationError("Authentication required");

      const parsed = req.body as import("@gatewerk/shared").CreateNoteBody;
      const { body, tags, is_shared, attachments } = parsed;
      // dual-auth middleware sets req.projectId only on api_key requests.
      // Session requests must echo project_id in the JSON body.
      const project_id = (req as any).projectId ?? parsed.project_id;
      if (!project_id) throw new InvalidRequestError("project_id required", "project_id", "missing_project_id");

      // AC #5: api_key cannot create private (spec §6.3).
      // Service identities are not people; "private to a script" is muddy
      // and would let an agent accumulate hidden state invisible to the team.
      if (subject.kind === "api_key" && is_shared === false) {
        throw new GatewerkError(
          "api_key subjects cannot create private notes",
          422,
          "invalid_request",
          "api_key_cannot_create_private",
        );
      }

      const author_id = subject.kind === "session" ? subject.userId : null;
      const author_display_fallback =
        subject.kind === "session"
          ? null
          : `api_key:${subject.projectId.slice(-8)}`;

      const id = generateId("note");
      const normalizedTags = tags.map((t) => t.toLowerCase());

      // M5: wrap the note insert + per-attachment cap+insert loop in a
      // transaction so a cap rejection on attachment N rolls back the note
      // row and any earlier attachment inserts. Without this the client
      // sees a 409 but a partial note + 1..N-1 attachments are stranded
      // in the DB.
      const createdAttachments = await db.transaction(async (tx) => {
        await tx.insert(notes).values({
          id,
          project_id,
          author_id,
          author_display_fallback,
          body,
          tags: normalizedTags,
          is_shared,
        });

        const created: Array<{
          id: string;
          target_kind: string;
          target_id: string;
          attached_by: string | null;
          attached_at: string;
        }> = [];
        for (const att of attachments) {
          await enforcePerTargetCap(tx, {
            target_kind: att.target_kind,
            target_id: att.target_id,
            is_shared,
            author_id,
          });
          const attId = generateId("pin");
          await tx.insert(noteAttachments).values({
            id: attId,
            note_id: id,
            target_kind: att.target_kind,
            target_id: att.target_id,
            attached_by: author_id,
          });
          created.push({
            id: attId,
            target_kind: att.target_kind,
            target_id: att.target_id,
            attached_by: author_id,
            attached_at: new Date().toISOString(),
          });
        }
        return created;
      });

      // Every note creation emits note.created, including private notes —
      // gating this on `is_shared` would leave the admin-visible audit
      // surface blind to roughly half of all note activity. The body stays
      // redacted at the detail/list endpoints; only the metadata (id,
      // project_id, tags count, is_shared flag) lands in the audit row.
      // note.shared / note.edited continue to fire only on visibility /
      // shared-body transitions in the PATCH handler below — those are
      // private-aware events that should not log on initial private
      // creation.
      await auditService.log({
        action: "note.created",
        actor: author_id ?? `api_key:${(subject as any).projectId}`,
        resource_type: "note",
        resource_id: id,
        // Top-level project_id required for tenant-scoped
        // GET /api/v1/audit query. project_id stays duplicated in details
        // for legacy log consumers.
        project_id,
        details: {
          project_id,
          is_shared,
          tags: normalizedTags,
          attachments: createdAttachments.length,
        },
      });

      res.status(201).json({
        id,
        project_id,
        author_id,
        author_display_fallback,
        body,
        tags: normalizedTags,
        is_shared,
        attachments: createdAttachments,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", rateLimitByKey(), validate({ body: PatchNoteBodySchema }), async (req, res, next) => {
    try {
      const subject = subjectFromRequest(req);
      if (!subject) throw new AuthenticationError("Authentication required");
      const subjectUser = subject.kind === "session" ? subject.userId : null;

      const [existing] = await db.select().from(notes).where(
        and(eq(notes.id, String(req.params.id)), isNull(notes.deleted_at)),
      );
      if (!existing) throw new NotFoundError("Note not found", "note_not_found");

      // Author guard (private+non-author → 404, shared+non-author → 403)
      if (existing.author_id !== subjectUser) {
        if (!existing.is_shared) {
          throw new NotFoundError("Note not found", "note_not_found");
        }
        throw new ForbiddenError("Only the author can edit this note", "not_author");
      }

      const patch = req.body as import("@gatewerk/shared").PatchNoteBody;

      const observedTs = new Date(patch.updated_at);
      if (observedTs.getTime() !== existing.updated_at.getTime()) {
        throw new ConflictError(
          "note has been modified since last fetch",
          "stale_updated_at",
        );
      }

      const flippedToShared = patch.is_shared === true && existing.is_shared === false;

      const newRow = {
        body: patch.body ?? existing.body,
        tags: patch.tags ? patch.tags.map((t) => t.toLowerCase()) : existing.tags,
        is_shared: patch.is_shared ?? existing.is_shared,
        updated_at: new Date(),
      };

      await db.update(notes).set(newRow).where(eq(notes.id, existing.id));

      // Mixed-event ordering (AC #11): visibility transition first, then
      // body/tags edit if applicable. note.shared fires only on flip;
      // note.edited fires only when the new state is shared.
      if (flippedToShared) {
        await auditService.log({
          action: "note.shared",
          actor: subjectUser!,
          resource_type: "note",
          resource_id: existing.id,
          // Wave 3 P2: top-level project_id for tenant-scoped audit query.
          project_id: existing.project_id,
          details: { previous_visibility: false },
        });
      }

      const bodyChanged = patch.body !== undefined && patch.body !== existing.body;
      const tagsChanged =
        patch.tags !== undefined &&
        JSON.stringify(patch.tags) !== JSON.stringify(existing.tags);
      if ((bodyChanged || tagsChanged) && newRow.is_shared) {
        const tagsAdded = newRow.tags.filter((t) => !existing.tags.includes(t));
        const tagsRemoved = existing.tags.filter((t) => !newRow.tags.includes(t));
        await auditService.log({
          action: "note.edited",
          actor: subjectUser!,
          resource_type: "note",
          resource_id: existing.id,
          // Wave 3 P2: top-level project_id for tenant-scoped audit query.
          project_id: existing.project_id,
          details: {
            tags_added: tagsAdded,
            tags_removed: tagsRemoved,
            length_delta: bodyChanged ? newRow.body.length - existing.body.length : 0,
          },
        });
      }

      const atts = await db
        .select()
        .from(noteAttachments)
        .where(eq(noteAttachments.note_id, existing.id));
      res.json({ ...existing, ...newRow, updated_at: newRow.updated_at.toISOString(), attachments: atts });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", rateLimitByKey(), async (req, res, next) => {
    try {
      const subject = subjectFromRequest(req);
      if (!subject || subject.kind !== "session") {
        throw new AuthenticationError("Session required");
      }
      const subjectUser = subject.userId;
      const isAdmin = isAdminSubject(subject);

      const [row] = await db.select().from(notes).where(
        and(eq(notes.id, String(req.params.id)), isNull(notes.deleted_at)),
      );
      if (!row) throw new NotFoundError("Note not found", "note_not_found");

      const isAuthor = row.author_id === subjectUser;

      // AC #18: admin attempting to delete other-user's private note returns
      // 404 (not 403) to avoid enumeration leak. Same defense as the detail
      // and PATCH handlers — admin cannot see private notes, therefore cannot
      // distinguish "exists but unauthorized" from "doesn't exist".
      if (!row.is_shared && !isAuthor) {
        throw new NotFoundError("Note not found", "note_not_found");
      }

      if (!isAuthor && !isAdmin) {
        throw new ForbiddenError("Only the author can delete this note", "not_author");
      }

      await db.update(notes).set({ deleted_at: new Date() }).where(eq(notes.id, row.id));

      if (row.is_shared) {
        await auditService.log({
          action: "note.deleted",
          actor: subjectUser,
          resource_type: "note",
          resource_id: row.id,
          // Wave 3 P2: top-level project_id for tenant-scoped audit query.
          project_id: row.project_id,
          details: { is_shared: true, by_admin: !isAuthor && isAdmin },
        });
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

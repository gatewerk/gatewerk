import { Router } from "express";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { notes } from "@gatewerk/db/src/schema/index";
import { AuthenticationError } from "@gatewerk/shared";
import { validate } from "../../middleware/validate";
import { subjectFromRequest } from "../../policy/subjects";
import { noteVisibilityWhere } from "../../services/notes-visibility";
import type { NotesRouteDeps } from "./_deps";

const TagsQuerySchema = z.object({
  project_id: z.string(),
});

export function createNotesTagRoutes(deps: NotesRouteDeps): Router {
  const router = Router();
  const { db } = deps;

  // GET /tags — distinct tags visible to the subject within the project.
  // unnest() flattens the tags[] array column; SELECT DISTINCT dedupes
  // across notes. Visibility predicate matches list/detail handlers
  // (shared OR self-authored private), so api_key subjects (subjectUser
  // null) collapse to shared-only — same null-branch behavior as
  // noteVisibilityWhere.
  router.get(
    "/tags",
    validate({ query: TagsQuerySchema }),
    async (req, res, next) => {
      try {
        const subject = subjectFromRequest(req);
        if (!subject) throw new AuthenticationError("Authentication required");
        const subjectUser = subject.kind === "session" ? subject.userId : null;
        const q = req.query as any;

        const tagExpr = sql<string>`unnest(${notes.tags})`.as("tag");
        const rows = await db
          .selectDistinct({ tag: tagExpr })
          .from(notes)
          .where(
            and(
              eq(notes.project_id, q.project_id),
              isNull(notes.deleted_at),
              noteVisibilityWhere(subjectUser),
            ),
          )
          .orderBy(asc(sql`tag`));

        const items = rows.map((r) => r.tag).filter((t): t is string => Boolean(t));
        res.json({ items });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

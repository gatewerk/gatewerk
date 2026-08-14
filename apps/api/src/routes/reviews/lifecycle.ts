import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import { reviewVersions } from "@gatewerk/db/src/schema/index";
import {
  envelope,
  NotFoundError,
} from "@gatewerk/shared";
import { requireScope } from "../../middleware/require-scope";
import { rateLimitByKey } from "../../middleware/rate-limit-key";
import { resolveProjectId } from "../../lib/resolve-project-id";
import { reviewPayload } from "./_helpers";
import type { ReviewRouteDeps } from "./_deps";

export function createReviewLifecycleRoutes(deps: ReviewRouteDeps): Router {
  const router = Router();
  const { db, service, auditService } = deps;

  // POST /api/v1/reviews/:id/archive — soft-delete (archived status)
  router.post("/:id/archive", requireScope("reviews:decide"), rateLimitByKey(), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db, String(req.params.id));
      if (!projectId) throw new NotFoundError("Review not found", "review_not_found");
      const updated = await service.archive(projectId, String(req.params.id));
      if (auditService) {
        const actor = (req as any).authType === "session"
          ? `reviewer:${(req as any).reviewer?.email}`
          : `agent:${(req as any).apiKeyPrefix || "unknown"}`;
        auditService.log({ action: "review.archived", actor, resource_type: "review", resource_id: updated.id, details: {}, project_id: projectId }).catch(() => {});
      }
      res.json(envelope("review", { ...reviewPayload(updated), iteration_count: updated.current_version - 1 }));
    } catch (err) { next(err); }
  });

  // POST /api/v1/reviews/:id/unarchive — restore from archived back to decided
  router.post("/:id/unarchive", requireScope("reviews:decide"), rateLimitByKey(), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db, String(req.params.id));
      if (!projectId) throw new NotFoundError("Review not found", "review_not_found");
      const updated = await service.unarchive(projectId, String(req.params.id));
      if (auditService) {
        const actor = (req as any).authType === "session"
          ? `reviewer:${(req as any).reviewer?.email}`
          : `agent:${(req as any).apiKeyPrefix || "unknown"}`;
        auditService.log({ action: "review.unarchived", actor, resource_type: "review", resource_id: updated.id, details: {}, project_id: projectId }).catch(() => {});
      }
      res.json(envelope("review", { ...reviewPayload(updated), iteration_count: updated.current_version - 1 }));
    } catch (err) { next(err); }
  });

  // GET /api/v1/reviews/:id/versions — get version history
  router.get("/:id/versions", requireScope("reviews:read"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db, String(req.params.id));
      if (!projectId) {
        throw new NotFoundError("Review not found", "review_not_found");
      }

      const versions = await db
        .select()
        .from(reviewVersions)
        .where(eq(reviewVersions.review_id, String(req.params.id)))
        .orderBy(desc(reviewVersions.version));

      res.json({ items: versions });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

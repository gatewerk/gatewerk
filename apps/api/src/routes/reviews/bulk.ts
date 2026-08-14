import { Router } from "express";
import { inArray } from "drizzle-orm";
import { reviews as reviewsTable } from "@gatewerk/db/src/schema/index";
import {
  InvalidRequestError,
  NotFoundError,
  ReviewBulkIdsBodySchema,
} from "@gatewerk/shared";
import { validate } from "../../middleware/validate";
import { requireScope } from "../../middleware/require-scope";
import { rateLimitByKey } from "../../middleware/rate-limit-key";
import { resolveProjectId } from "../../lib/resolve-project-id";
import type { ReviewRouteDeps } from "./_deps";

// IMPORTANT: bulk routes must be registered BEFORE /:id routes (in the parent
// index.ts mount order) so Express doesn't match "bulk" as an :id path parameter.
export function createReviewBulkRoutes(deps: ReviewRouteDeps): Router {
  const router = Router();
  const { db, service, auditService } = deps;

  // Wave 3 P2: validate that all ids in the bulk request belong to the same
  // project. Pre-fix the route resolved projectId from ids[0] and the service
  // silently filtered the rest by `eq(project_id, projectId)`, so cross-project
  // arrays partially-applied with a misleading `count`. This helper short-
  // circuits with 400 mixed_projects before any mutation runs.
  async function assertSingleProjectIds(ids: string[]): Promise<string> {
    if (ids.length === 0) {
      throw new InvalidRequestError("ids cannot be empty", "ids", "ids_empty");
    }
    const rows = await db
      .select({ id: reviewsTable.id, project_id: reviewsTable.project_id })
      .from(reviewsTable)
      .where(inArray(reviewsTable.id, ids));
    if (rows.length === 0) {
      throw new NotFoundError("Review not found", "review_not_found");
    }
    const projectIds = new Set(rows.map((r) => r.project_id));
    if (projectIds.size > 1) {
      throw new InvalidRequestError(
        "ids span multiple projects; bulk operations require a single project",
        "ids",
        "mixed_projects",
      );
    }
    return rows[0].project_id;
  }

  // POST /api/v1/reviews/bulk/archive — bulk archive
  router.post("/bulk/archive", requireScope("reviews:decide"), rateLimitByKey(), validate({ body: ReviewBulkIdsBodySchema }), async (req, res, next) => {
    try {
      const { ids } = req.body as { ids: string[] };
      const idsProjectId = await assertSingleProjectIds(ids);
      // resolveProjectId still runs to honour api-key-bound projectId (req.projectId
      // wins). If the caller's auth project disagrees with the ids' project, the
      // service-level eq(project_id, …) filter naturally drops the mismatched ids;
      // the explicit mixed_projects check above prevents the more dangerous case
      // of partial cross-project mutation under a session admin.
      const projectId = (await resolveProjectId(req, db, ids[0])) ?? idsProjectId;
      const { count, archived_ids } = await service.bulkArchive(projectId, ids);
      if (auditService) {
        const actor = (req as any).authType === "session"
          ? `reviewer:${(req as any).reviewer?.email}`
          : `agent:${(req as any).apiKeyPrefix || "unknown"}`;
        auditService.log({ action: "review.bulk_archived", actor, resource_type: "review", resource_id: "bulk", details: { count, ids }, project_id: projectId }).catch(() => {});
      }
      // archived_ids is additive: the client's Undo must only target rows that
      // actually flipped (monitoring rows are skipped by the service predicate).
      res.json({ ok: true, count, archived_ids });
    } catch (err) { next(err); }
  });

  // POST /api/v1/reviews/bulk/delete — bulk delete
  router.post("/bulk/delete", requireScope("reviews:decide"), rateLimitByKey(), validate({ body: ReviewBulkIdsBodySchema }), async (req, res, next) => {
    try {
      const { ids } = req.body as { ids: string[] };
      const idsProjectId = await assertSingleProjectIds(ids);
      const projectId = (await resolveProjectId(req, db, ids[0])) ?? idsProjectId;
      const { count, deleted_ids } = await service.bulkDelete(projectId, ids);
      if (auditService) {
        const actor = (req as any).authType === "session"
          ? `reviewer:${(req as any).reviewer?.email}`
          : `agent:${(req as any).apiKeyPrefix || "unknown"}`;
        auditService.log({ action: "review.bulk_deleted", actor, resource_type: "review", resource_id: "bulk", details: { count, ids }, project_id: projectId }).catch(() => {});
      }
      res.json({ ok: true, count, deleted_ids });
    } catch (err) { next(err); }
  });

  return router;
}

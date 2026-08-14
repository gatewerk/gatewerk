import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { reviews, templates } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import { NotFoundError } from "@gatewerk/shared";
import { requireScope } from "../middleware/require-scope";
import { resolveProjectId } from "../lib/resolve-project-id";

// Per-route authz coverage:
// `stats:read` scope required; template ownership checked against the caller's
// active project before aggregates are returned. Without this guard, any
// authenticated caller (including API keys lacking templates:read/stats:read)
// could read template aggregates for any template id — a scope bypass locally
// and a cross-project metric leak on multi-tenant deployments. Siblings:
// `routes/stats.ts` (DELTA 2) applies the same project-scoping fix.
export function createTemplateStatsRoutes(db: AppDb): Router {
  const router = Router();

  // GET /api/v1/templates/:id/stats
  router.get("/:id/stats", requireScope("stats:read"), async (req, res, next) => {
    try {
      const id = String(req.params.id);

      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      // Ownership gate: template must belong to the caller's active project.
      // Returning 404 (not 403) matches the rest of the surface — unowned
      // resources are indistinguishable from non-existent ones.
      const [tpl] = await db
        .select({ id: templates.id })
        .from(templates)
        .where(and(eq(templates.id, id), eq(templates.project_id, projectId)))
        .limit(1);
      if (!tpl) {
        throw new NotFoundError("Template not found", "template_not_found");
      }

      const [stats] = await db
        .select({
          total: sql<number>`cast(count(*) as int)`,
          approved: sql<number>`cast(count(*) filter (where ${reviews.decision} = 'approved') as int)`,
          rejected: sql<number>`cast(count(*) filter (where ${reviews.decision} = 'rejected') as int)`,
          edited: sql<number>`cast(count(*) filter (where ${reviews.edited_payload} is not null and ${reviews.decision} = 'approved') as int)`,
          auto_approved: sql<number>`cast(count(*) filter (where ${reviews.decided_by} = 'system/auto-approve') as int)`,
          vetoed: sql<number>`cast(count(*) filter (where ${reviews.decision} = 'vetoed') as int)`,
          confirmed_human: sql<number>`cast(count(*) filter (where ${reviews.decision} = 'confirmed' and ${reviews.decided_by} IS DISTINCT FROM 'system:monitoring_window') as int)`,
          window_elapsed: sql<number>`cast(count(*) filter (where ${reviews.decision} = 'confirmed' and ${reviews.decided_by} = 'system:monitoring_window') as int)`,
          avg_seconds: sql<number>`coalesce(cast(
            extract(epoch from avg(${reviews.decided_at} - ${reviews.created_at}) filter (where ${reviews.decided_at} is not null and (${reviews.decided_by} IS NULL OR ${reviews.decided_by} NOT LIKE 'system%')))
            as numeric), 0)`,
          pending: sql<number>`cast(count(*) filter (where ${reviews.status} = 'pending') as int)`,
          waiting: sql<number>`cast(count(*) filter (where ${reviews.status} = 'awaiting_iteration') as int)`,
        })
        .from(reviews)
        .where(and(eq(reviews.template_id, id), eq(reviews.project_id, projectId)));

      const humanDecided = stats.total - stats.auto_approved - stats.pending - stats.waiting;

      res.json({
        total_reviews: stats.total,
        human_decided: humanDecided,
        auto_approved: stats.auto_approved,
        vetoed: stats.vetoed,
        confirmed_human: stats.confirmed_human,
        window_elapsed: stats.window_elapsed,
        pending_now: stats.pending,
        waiting_now: stats.waiting,
        approval_rate: humanDecided > 0 ? Math.round((stats.approved / humanDecided) * 100) : null,
        rejection_rate: humanDecided > 0 ? Math.round((stats.rejected / humanDecided) * 100) : null,
        edit_rate: stats.approved > 0 ? Math.round((stats.edited / stats.approved) * 100) : null,
        avg_decision_minutes: stats.avg_seconds > 0 ? Math.round((stats.avg_seconds / 60) * 10) / 10 : null,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

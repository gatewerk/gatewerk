import { Router } from "express";
import { eq, sql, and, gte, count } from "drizzle-orm";
import { reviews } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import { NotFoundError } from "@gatewerk/shared";
import { requireScope } from "../middleware/require-scope";
import { resolveProjectId } from "../lib/resolve-project-id";

export function createStatsRoutes(db: AppDb): Router {
  const router = Router();

  // GET /api/v1/stats — Returns review metrics and counts.
  //
  // Per-route authz coverage: both auth types are project-scoped. Previously
  // only `authType === "apikey"` applied the project-id filter, so
  // session-authed callers received global aggregates — benign on OSS
  // single-project, a cross-tenant metric leak on cloud. Same human-only
  // exclusion as the per-template avg in routes/template-stats.ts; keep the
  // two filters aligned.
  router.get("/", requireScope("stats:read"), async (req, res, next) => {
    try {
      // resolveProjectId returns req.projectId for API keys, and the session's
      // active project (single-project fallback on OSS) for JWT callers.
      const projectId = (req as any).projectId ?? (await resolveProjectId(req, db));
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const baseCondition = eq(reviews.project_id, projectId);
      const decisionCondition = and(baseCondition, eq(reviews.status, "decided"));

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const recentCondition = and(baseCondition, gte(reviews.created_at, thirtyDaysAgo));

      // Run all 6 independent queries in parallel
      const [
        [totalRow],
        statusRows,
        decisionRows,
        decidedRows,
        templateRows,
        recentRows,
      ] = await Promise.all([
        db.select({ value: count() }).from(reviews).where(baseCondition),
        db.select({ status: reviews.status, value: count() }).from(reviews).where(baseCondition).groupBy(reviews.status),
        db.select({ decision: reviews.decision, value: count() }).from(reviews).where(decisionCondition).groupBy(reviews.decision),
        // response time means HUMAN response time; system-actor decisions
        // (timeouts, caps, window lapses, auto approvals) are not responses.
        // NOT LIKE 'system%' catches: system/auto-approve, system:timeout,
        // system:max_iterations, system:monitoring_window. Null-safe IS NULL
        // guard matches the loop's existing null tolerance for decided_at.
        db.select({ created_at: reviews.created_at, decided_at: reviews.decided_at }).from(reviews).where(and(decisionCondition, sql`(${reviews.decided_by} IS NULL OR ${reviews.decided_by} NOT LIKE 'system%')`)),
        db.select({ template_slug: reviews.template_slug, value: count() }).from(reviews).where(baseCondition).groupBy(reviews.template_slug),
        db.select({ created_at: reviews.created_at }).from(reviews).where(recentCondition),
      ]);

      const total = Number(totalRow?.value ?? 0);

      const by_status: Record<string, number> = {};
      for (const row of statusRows) {
        by_status[row.status] = Number(row.value);
      }

      const by_decision: Record<string, number> = {};
      for (const row of decisionRows) {
        if (row.decision) {
          by_decision[row.decision] = Number(row.value);
        }
      }

      let avg_review_time_ms: number | null = null;
      if (decidedRows.length > 0) {
        let totalMs = 0;
        let validCount = 0;
        for (const row of decidedRows) {
          if (row.decided_at && row.created_at) {
            totalMs += new Date(row.decided_at).getTime() - new Date(row.created_at).getTime();
            validCount++;
          }
        }
        if (validCount > 0) {
          avg_review_time_ms = Math.round(totalMs / validCount);
        }
      }

      const by_template = templateRows.map((row: any) => ({
        template_slug: row.template_slug,
        count: Number(row.value),
      }));

      const dayCounts: Record<string, number> = {};
      for (const row of recentRows) {
        const dateStr = new Date(row.created_at).toISOString().split("T")[0];
        dayCounts[dateStr] = (dayCounts[dateStr] || 0) + 1;
      }

      const reviews_per_day = Object.entries(dayCounts)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));

      res.json({
        object: "stats",
        total,
        by_status,
        by_decision,
        avg_review_time_ms,
        by_template,
        reviews_per_day,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

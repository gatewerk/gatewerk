import { Router } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import { reviews } from "@gatewerk/db/src/schema/index";
import { listEnvelope } from "@gatewerk/shared";
import type { FeedbackItem, Decision } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import { requireScope } from "../middleware/require-scope";
import { parsePagination } from "../lib/pagination";

export function createFeedbackRoutes(db: AppDb): Router {
  const router = Router();

  // GET /api/v1/feedback — query decided reviews as feedback items
  router.get("/", requireScope("feedback:read"), async (req, res, next) => {
    try {
      const projectId = (req as any).projectId;
      const { template, outcome } = req.query as Record<string, string>;

      const { limit: parsedLimit, offset: parsedOffset } = parsePagination(req.query);

      // Build conditions: project scoping + status = "decided"
      const conditions = [
        eq(reviews.project_id, projectId),
        eq(reviews.status, "decided"),
        // Window-lapsed auto-confirms are absence-of-objection, not human
        // signal — they must not feed agent self-learning as positive
        // examples (spec §4.5). IS DISTINCT FROM is null-safe.
        sql`${reviews.decided_by} IS DISTINCT FROM 'system:monitoring_window'`,
      ];

      if (template) {
        conditions.push(eq(reviews.template_slug, template));
      }

      if (outcome) {
        conditions.push(eq(reviews.decision, outcome));
      }

      const rows = await db
        .select()
        .from(reviews)
        .where(and(...conditions))
        .orderBy(desc(reviews.decided_at))
        .limit(parsedLimit + 1) // fetch one extra to determine has_more
        .offset(parsedOffset);

      const has_more = rows.length > parsedLimit;
      const sliced = has_more ? rows.slice(0, parsedLimit) : rows;

      const items: FeedbackItem[] = sliced.map((r: any) => {
        const item: FeedbackItem = {
          review_id: r.id,
          template: r.template_slug,
          decision: r.decision as Decision,
          original_payload: r.payload as Record<string, unknown>,
          decided_at: r.decided_at.toISOString(),
        };

        if (r.suggested_value) {
          item.suggested_value = r.suggested_value as Record<string, unknown>;
        }
        if (r.approved_value) {
          item.approved_value = r.approved_value as Record<string, unknown>;
        }
        if (r.edited_payload) {
          item.edited_payload = r.edited_payload as Record<string, unknown>;
          item.was_edited = true;
        }
        if (r.feedback) {
          item.feedback = r.feedback;
        }

        return item;
      });

      res.json(listEnvelope("feedback", items, { has_more, total: items.length }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

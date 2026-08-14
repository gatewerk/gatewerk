import { Router } from "express";
import { eq, and, desc, isNull, inArray, gte, lte } from "drizzle-orm";
import { webhookDeliveries, reviews } from "@gatewerk/db/src/schema/index";
import { listEnvelope, NotFoundError, InvalidRequestError, ConflictError } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import { requireScope } from "../middleware/require-scope";
import { resolveProjectId } from "../lib/resolve-project-id";
import type { AuditService } from "../services/audit";
import { parsePagination } from "../lib/pagination";

export function createWebhookDeliveryRoutes(
  db: AppDb,
  auditService?: AuditService,
): Router {
  const router = Router();

  // GET /api/v1/webhooks/deliveries
  // dualAuth-mounted (Admin Observability). API-key callers get req.projectId
  // from apiKeyAuth; session callers fall through to resolveProjectId (oldest
  // project for the user's org). Same pattern used by /audit and /stats.
  router.get("/", requireScope("audit:read"), async (req, res, next) => {
    try {
      const projectId = (req as any).projectId ?? (await resolveProjectId(req, db));
      const { review_id, status, from, to } = req.query as Record<string, string>;
      // Repeated `?event_type=a&event_type=b` parses to string[]; a single
      // `?event_type=a` stays a plain string — same contract as /audit's
      // `action` filter (routes/audit.ts), read the same way rather than
      // forced through the Record<string,string> cast above.
      const event_type = req.query.event_type as string | string[] | undefined;

      const { limit: parsedLimit, offset: parsedOffset } = parsePagination(req.query);

      // Get review IDs for this project to scope deliveries
      const projectReviews = await db
        .select({ id: reviews.id })
        .from(reviews)
        .where(eq(reviews.project_id, projectId));

      const reviewIds = new Set(projectReviews.map((r: any) => r.id));

      // Build query conditions
      const conditions: any[] = [];

      if (review_id) {
        conditions.push(eq(webhookDeliveries.review_id, review_id));
      }

      if (status) {
        conditions.push(eq(webhookDeliveries.status, status));
      }

      if (event_type) {
        const eventTypes = Array.isArray(event_type) ? event_type : [event_type];
        if (eventTypes.length > 0) conditions.push(inArray(webhookDeliveries.event_type, eventTypes));
      }

      // `from`/`to` arrive as full instants (the client already resolved a
      // picked date to the reviewer's own local start/end-of-day) — this
      // route does no day-boundary math of its own, same contract as
      // /audit's from/to.
      if (from) {
        conditions.push(gte(webhookDeliveries.created_at, new Date(from)));
      }
      if (to) {
        conditions.push(lte(webhookDeliveries.created_at, new Date(to)));
      }

      let rows = await db
        .select()
        .from(webhookDeliveries)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(webhookDeliveries.created_at))
        .limit(parsedLimit + 1)
        .offset(parsedOffset);

      // Filter to only this project's reviews
      rows = rows.filter((r: any) => reviewIds.has(r.review_id));

      const has_more = rows.length > parsedLimit;
      const sliced = has_more ? rows.slice(0, parsedLimit) : rows;

      // Strip hmac_secret from response
      const items = sliced.map((r: any) => ({
        id: r.id,
        object: "webhook_delivery",
        review_id: r.review_id,
        event_type: r.event_type,
        url: r.url,
        status: r.status,
        attempts: r.attempts,
        max_attempts: r.max_attempts,
        last_attempt_at: r.last_attempt_at?.toISOString() || null,
        next_attempt_at: r.next_attempt_at?.toISOString() || null,
        last_error: r.last_error,
        delivered_at: r.delivered_at?.toISOString() || null,
        created_at: r.created_at.toISOString(),
      }));

      res.json(listEnvelope("webhook_delivery", items, { has_more, total: items.length }));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/webhooks/deliveries/:id/retry
  // Queues a failed or pending delivery for immediate re-attempt.
  // Ownership is verified via JOIN to reviews so cross-project access → 404.
  // Returns 400 if already delivered, 409 if the retry worker holds the row
  // (claimed_by IS NOT NULL guard). Does NOT bump `attempts` — the worker
  // owns the backoff counter.
  router.post("/:id/retry", requireScope("reviews:decide"), async (req, res, next) => {
    try {
      const deliveryId = String(req.params.id);
      const projectId = (req as any).projectId ?? (await resolveProjectId(req, db));

      // Ownership check: webhook_deliveries has no project_id column.
      // Fetch the delivery first, then verify its review belongs to the
      // caller's project via a separate review lookup (mirrors the GET
      // route's two-step filter pattern for PGlite JOIN compatibility).
      const [delivery] = await db
        .select({
          id: webhookDeliveries.id,
          status: webhookDeliveries.status,
          review_id: webhookDeliveries.review_id,
        })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId))
        .limit(1);

      if (!delivery) {
        throw new NotFoundError("Delivery not found.");
      }

      // Cross-project access → 404 (same response as not-found to avoid
      // leaking delivery existence to callers from other projects).
      const [ownerReview] = await db
        .select({ id: reviews.id })
        .from(reviews)
        .where(and(eq(reviews.id, delivery.review_id), eq(reviews.project_id, projectId)))
        .limit(1);

      if (!ownerReview) {
        throw new NotFoundError("Delivery not found.");
      }

      if (delivery.status === "delivered") {
        throw new InvalidRequestError("This delivery has already been delivered.", undefined, "already_delivered");
      }

      // Atomic update: only re-queue an unclaimed, non-terminal row. The
      // status guard is load-bearing (NOT just the pre-SELECT 400 above):
      // the worker delivers by setting status=delivered AND clearing
      // claimed_by, so between our status-SELECT and this UPDATE a delivery
      // can flip to delivered with claimed_by null again. Without
      // `status IN (pending, failed)` here, this UPDATE would match that
      // just-delivered row and flip delivered→pending → worker re-delivers
      // (double-delivery). Zero rows returned → worker holds it OR it was
      // delivered mid-flight → 409.
      const [updated] = await db
        .update(webhookDeliveries)
        .set({ status: "pending", next_attempt_at: new Date(), last_error: null })
        .where(and(
          eq(webhookDeliveries.id, deliveryId),
          isNull(webhookDeliveries.claimed_by),
          inArray(webhookDeliveries.status, ["pending", "failed"]),
        ))
        .returning();

      if (!updated) {
        throw new ConflictError("Delivery is currently being processed. Try again in a moment.", "delivery_claimed");
      }

      // Tier 3 BEST_EFFORT (services/AUDIT-WRITE-CONTRACT.md). Dual-auth route,
      // so the actor may be a session reviewer or an API key.
      if (auditService) {
        auditService.logBestEffort(
          {
            action: "webhook_delivery.retried",
            actor: (req as any).reviewer?.email
              ? `reviewer:${(req as any).reviewer.email}`
              : `agent:${(req as any).apiKeyPrefix || "unknown"}`,
            resource_type: "webhook_delivery",
            resource_id: updated.id,
            details: {
              review_id: updated.review_id,
              event_type: updated.event_type,
              attempts: updated.attempts,
              status_before: delivery.status,
              status_after: updated.status,
            },
            project_id: projectId,
          },
          "a retry is reconstructible from the delivery row itself",
        );
      }

      return res.json({
        id: updated.id,
        status: updated.status,
        queued_at: updated.next_attempt_at?.toISOString() ?? new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

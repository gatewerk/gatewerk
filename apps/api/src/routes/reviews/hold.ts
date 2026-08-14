import { Router } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { reviews as reviewsTable } from "@gatewerk/db/src/schema/index";
import {
  envelope,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ReviewAssignBodySchema,
  ReviewSnoozeBodySchema,
} from "@gatewerk/shared";
import { requireScope } from "../../middleware/require-scope";
import { validate } from "../../middleware/validate";
import { rateLimitByKey } from "../../middleware/rate-limit-key";
import { resolveProjectId } from "../../lib/resolve-project-id";
import { reviewPayload } from "./_helpers";
import { can, isAdminSession, subjectFromRequest } from "../../policy";
import type { ReviewRouteDeps } from "./_deps";

// The single actor identity, reused for BOTH the audit `actor` field AND the
// `held_by` soft-lock value. It MUST be non-null for every auth type or the
// atomic claim would set held_by=NULL and the lock would silently never engage
// (a second claim would keep "succeeding"). Session → reviewer:<email>;
// api-key → agent:<prefix> (or apikey:<id> if no prefix). Returns null only
// when no identity can be resolved, in which case the caller rejects with 4xx.
function resolveActor(req: any): string | null {
  if (req.authType === "session") {
    const email = req.reviewer?.email as string | undefined;
    return email ? `reviewer:${email}` : null;
  }
  if (req.authType === "apikey") {
    const prefix = req.apiKeyPrefix as string | undefined;
    if (prefix) return `agent:${prefix}`;
    const id = req.apiKeyId as string | undefined;
    return id ? `apikey:${id}` : null;
  }
  return null;
}

// Normalize an assignee string into the SAME identity format `held_by` carries
// after a claim, so an assign+hold recipient can self-release. A session
// reviewer presents on release as `reviewer:<email>` (see resolveActor); a
// bare-email assignee must therefore be stored prefixed. If the assignee
// already carries a known prefix (reviewer:/role:/agent:/apikey:) it is stored
// as-is.
const HOLD_IDENTITY_PREFIXES = ["reviewer:", "role:", "agent:", "apikey:"];
function normalizeHoldIdentity(assignee: string): string {
  return HOLD_IDENTITY_PREFIXES.some((p) => assignee.startsWith(p))
    ? assignee
    : `reviewer:${assignee}`;
}

export function createReviewHoldRoutes(deps: ReviewRouteDeps): Router {
  const router = Router();
  const { db, auditService } = deps;

  // POST /:id/claim — atomic soft-lock on held_by IS NULL.
  // ?force=true (requires reviews:assign) overwrites an existing hold.
  router.post("/:id/claim", requireScope("reviews:claim"), rateLimitByKey(), async (req, res, next) => {
    try {
      const reviewId = String(req.params.id);
      const projectId = await resolveProjectId(req, db, reviewId);
      if (!projectId) throw new NotFoundError("Review not found", "review_not_found");

      // Non-null actor identity for both the soft-lock and the audit trail. If
      // it cannot be resolved we reject rather than silently set held_by=NULL.
      const actor = resolveActor(req);
      if (!actor) {
        throw new ForbiddenError("Cannot resolve a caller identity to hold this review", "actor_unresolved");
      }
      const force = req.query.force === "true";

      // Atomic claim: only succeeds when held_by IS NULL.
      const [updated] = await db
        .update(reviewsTable)
        .set({ held_by: actor, held_at: new Date() })
        .where(
          and(
            eq(reviewsTable.id, reviewId),
            eq(reviewsTable.project_id, projectId),
            isNull(reviewsTable.held_by),
          ),
        )
        .returning();

      if (updated) {
        auditService?.log({ action: "review.claimed", actor, resource_type: "review", resource_id: updated.id, details: {}, project_id: projectId }).catch(() => {});
        return res.json(envelope("review", reviewPayload(updated)));
      }

      // Zero rows → review is already held.
      if (!force) {
        throw new ConflictError("Review is already held by another reviewer", "review_already_held");
      }

      // Force path: reviewer must additionally hold reviews:assign.
      const subject = subjectFromRequest(req);
      if (!subject || !can(subject, ["reviews:assign"]).allow) {
        throw new ForbiddenError("reviews:assign scope required to force-claim a held review", "forbidden");
      }

      // Overwrite: no held_by IS NULL predicate.
      const [forced] = await db
        .update(reviewsTable)
        .set({ held_by: actor, held_at: new Date() })
        .where(and(eq(reviewsTable.id, reviewId), eq(reviewsTable.project_id, projectId)))
        .returning();
      if (!forced) throw new NotFoundError("Review not found", "review_not_found");

      auditService?.log({ action: "review.claimed", actor, resource_type: "review", resource_id: forced.id, details: { force: true }, project_id: projectId }).catch(() => {});
      return res.json(envelope("review", reviewPayload(forced)));
    } catch (err) { next(err); }
  });

  // POST /:id/release — clears held_by. Restricted to the current holder OR admin.
  router.post("/:id/release", requireScope("reviews:release"), rateLimitByKey(), async (req, res, next) => {
    try {
      const reviewId = String(req.params.id);
      const projectId = await resolveProjectId(req, db, reviewId);
      if (!projectId) throw new NotFoundError("Review not found", "review_not_found");

      const [current] = await db
        .select({ held_by: reviewsTable.held_by })
        .from(reviewsTable)
        .where(and(eq(reviewsTable.id, reviewId), eq(reviewsTable.project_id, projectId)))
        .limit(1);
      if (!current) throw new NotFoundError("Review not found", "review_not_found");

      // Symmetric with claim: compare the current holder against the SAME
      // actor identity that claim stored in held_by. Only that holder (or an
      // admin) may release.
      const actor = resolveActor(req);
      const isHolder = current.held_by !== null && current.held_by === actor;
      if (!isHolder && !isAdminSession(req)) {
        throw new ForbiddenError("Only the current holder or an admin may release a hold", "forbidden");
      }

      // Atomic release: only clear if held_by is still what we authorized
      // against. A concurrent force-claim in the read-authorize-write window
      // would otherwise be silently clobbered by the old holder.
      const holdPredicate = current.held_by === null
        ? isNull(reviewsTable.held_by)
        : eq(reviewsTable.held_by, current.held_by);
      const [updated] = await db
        .update(reviewsTable)
        .set({ held_by: null, held_at: null })
        .where(and(eq(reviewsTable.id, reviewId), eq(reviewsTable.project_id, projectId), holdPredicate))
        .returning();
      if (!updated) throw new ConflictError("The hold changed before release; retry", "review_hold_changed");

      const auditActor = actor ?? "unknown";
      auditService?.log({ action: "review.released", actor: auditActor, resource_type: "review", resource_id: updated.id, details: {}, project_id: projectId }).catch(() => {});
      return res.json(envelope("review", reviewPayload(updated)));
    } catch (err) { next(err); }
  });

  // POST /:id/assign — set assignee (and held_by when hold:true).
  // assignee and held_by are distinct fields; hold just pins the hold to the new assignee.
  router.post("/:id/assign", requireScope("reviews:assign"), validate({ body: ReviewAssignBodySchema }), rateLimitByKey(), async (req, res, next) => {
    try {
      const reviewId = String(req.params.id);
      const projectId = await resolveProjectId(req, db, reviewId);
      if (!projectId) throw new NotFoundError("Review not found", "review_not_found");

      const { assignee, hold } = req.body as { assignee: string; hold: boolean };
      const setValues: Record<string, unknown> = { assignee };
      if (hold) {
        // Store held_by in the actor-identity format the assignee presents with
        // on release (reviewer:<email>), so they can self-release this hold.
        setValues.held_by = normalizeHoldIdentity(assignee);
        setValues.held_at = new Date();
      }

      const [updated] = await db
        .update(reviewsTable)
        .set(setValues)
        .where(and(eq(reviewsTable.id, reviewId), eq(reviewsTable.project_id, projectId)))
        .returning();
      if (!updated) throw new NotFoundError("Review not found", "review_not_found");

      const actor = resolveActor(req) ?? "unknown";
      auditService?.log({ action: "review.assigned", actor, resource_type: "review", resource_id: updated.id, details: { assignee, hold: !!hold }, project_id: projectId }).catch(() => {});
      return res.json(envelope("review", reviewPayload(updated)));
    } catch (err) { next(err); }
  });

  // POST /:id/snooze — set snoozed_until (or null to cancel).
  router.post("/:id/snooze", requireScope("reviews:claim"), validate({ body: ReviewSnoozeBodySchema }), rateLimitByKey(), async (req, res, next) => {
    try {
      const reviewId = String(req.params.id);
      const projectId = await resolveProjectId(req, db, reviewId);
      if (!projectId) throw new NotFoundError("Review not found", "review_not_found");

      const { until } = req.body as { until: string | null };
      const snoozedUntil = until === null ? null : new Date(until);

      const [updated] = await db
        .update(reviewsTable)
        .set({ snoozed_until: snoozedUntil })
        .where(
          and(
            eq(reviewsTable.id, reviewId),
            eq(reviewsTable.project_id, projectId),
            sql`${reviewsTable.status} <> 'monitoring'`,
          ),
        )
        .returning();
      if (!updated) {
        const [row] = await db
          .select({ status: reviewsTable.status })
          .from(reviewsTable)
          .where(and(eq(reviewsTable.id, reviewId), eq(reviewsTable.project_id, projectId)))
          .limit(1);
        if (row?.status === "monitoring") {
          // You cannot pause a real-world undo deadline (spec Q4).
          throw new ConflictError("Monitoring reviews cannot be snoozed.", "monitoring_not_snoozable");
        }
        throw new NotFoundError("Review not found", "review_not_found");
      }

      const actor = resolveActor(req) ?? "unknown";
      auditService?.log({ action: "review.snoozed", actor, resource_type: "review", resource_id: updated.id, details: { until }, project_id: projectId }).catch(() => {});
      return res.json(envelope("review", reviewPayload(updated)));
    } catch (err) { next(err); }
  });

  return router;
}

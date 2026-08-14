import { Router } from "express";
import { and, eq, isNull, lt, gte, count as drizzleCount, sql } from "drizzle-orm";
import { reviewTokens, reviews } from "@gatewerk/db/src/schema/index";
import type { ReviewRouteDeps } from "./_deps";
import { requireScope } from "../../middleware/require-scope";
import type { ExpiredTokenSummaryResponse } from "@gatewerk/shared";

// Returns the count of manually-issued review tokens that expired without
// a decision while the parent review is still awaiting_external. Scoped
// to the calling reviewer's own tokens. Sample is capped at 5 so the
// banner can link to the affected reviews without fetching unbounded data
// on every poll.
export function createExpiredTokenRoutes(deps: ReviewRouteDeps): Router {
  const router = Router();
  const { db, auditService } = deps;

  router.get(
    "/expired-token-summary",
    requireScope("reviews:read"),
    async (req, res, next) => {
      try {
        const authType = (req as any).authType as "apikey" | "session" | undefined;
        const reviewer = (req as any).reviewer as { id?: string; email?: string } | undefined;

        if (authType === "apikey") {
          // API-key callers have no per-user banner concept. Return empty
          // explicitly so the contract is documented at this branch.
          res.json({ count: 0, sample_review_ids: [] });
          return;
        }

        if (!reviewer?.id) {
          // Session caller with no id is an auth contract violation, not a
          // banner no-op. Surface honestly so a future regression in the auth
          // middleware doesn't silently blank the banner for all users.
          return next(new Error("session reviewer missing id"));
        }

        const userId = reviewer.id;
        const now = new Date();

        // Scoped to the same user's manual reshares — a peer admin's separate
        // share on the same review must not silently hide this user's expired
        // token, otherwise the banner suppresses exactly the invariant it
        // exists to surface.
        const liveTokenReviewIds = db
          .select({ review_id: reviewTokens.review_id })
          .from(reviewTokens)
          .where(
            and(
              eq(reviewTokens.created_by_kind, "manual"),
              eq(reviewTokens.created_by_id, userId),
              isNull(reviewTokens.revoked_at),
              isNull(reviewTokens.decided_by_email),
              isNull(reviewTokens.decided_by_user_id),
              gte(reviewTokens.expires_at, now),
              eq(reviewTokens.is_preview, false),
            ),
          );

        const countResult = await db
          .selectDistinct({ review_id: reviewTokens.review_id })
          .from(reviewTokens)
          .innerJoin(reviews, eq(reviews.id, reviewTokens.review_id))
          .where(
            and(
              eq(reviewTokens.created_by_kind, "manual"),
              eq(reviewTokens.created_by_id, userId),
              isNull(reviewTokens.revoked_at),
              isNull(reviewTokens.decided_by_email),
              isNull(reviewTokens.decided_by_user_id),
              lt(reviewTokens.expires_at, now),
              eq(reviewTokens.is_preview, false),
              eq(reviews.status, "awaiting_external"),
              sql`${reviewTokens.review_id} NOT IN ${liveTokenReviewIds}`,
            ),
          );

        const count = countResult.length;
        const sample_review_ids: string[] =
          count > 0
            ? countResult.slice(0, 5).map((r: { review_id: string }) => r.review_id)
            : [];

        const body: ExpiredTokenSummaryResponse = { count, sample_review_ids };

        // Audit only when count > 0 — avoids flooding audit_log with every
        // banner poll when there are no expired tokens to surface.
        // Pre-empts the invariant-pair-mutation family: surface read failure
        // via next(err) rather than silently returning count:0 (which the
        // client would render as zero-state, lying about expired tokens existing).
        if (body.count > 0 && auditService) {
          // Audit failure must NOT taint a successful banner read. The body
          // is already correctly computed; losing the audit row is much
          // lower-severity than blanking the banner across all polls during
          // an audit outage. Matches the fire-and-forget pattern in tokens.ts.
          auditService
            .log({
              action: "token.expired_summary_queried",
              actor: `reviewer:${reviewer.email ?? userId}`,
              resource_type: "review_token",
              details: { count: body.count, sample_review_ids: body.sample_review_ids },
            })
            .catch(() => { /* swallow — audit chain gap is observable at the DB level */ });
        }

        res.json(body);
      } catch (err) {
        // Do NOT swallow into count:0. Surface honestly so the client renders
        // nothing rather than lying "no expired tokens" on a read failure.
        next(err);
      }
    },
  );

  return router;
}

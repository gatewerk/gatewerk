import { and, eq, isNull, lt, gte, sql } from "drizzle-orm";
import { reviewTokens, reviews, reviewers } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";

export interface DailyDigestBatch {
  reviewer_id: string;
  email: string;
  count: number;
  sample_review_ids: string[];
}

// Mirrors apps/api/src/routes/reviews/expired.ts but UN-SCOPED by reviewer
// (returns batches for every reviewer with ≥1 expired manual token). The
// same scoping invariants apply: manual tokens only, not preview, not
// decided, not revoked, parent review still awaiting_external, no sibling
// live token on the same review.
export async function computeDailyDigestBatches(
  db: AppDb,
  now: Date,
): Promise<DailyDigestBatch[]> {
  const liveTokenReviewIds = db
    .select({ review_id: reviewTokens.review_id })
    .from(reviewTokens)
    .where(
      and(
        eq(reviewTokens.created_by_kind, "manual"),
        isNull(reviewTokens.revoked_at),
        isNull(reviewTokens.decided_by_email),
        isNull(reviewTokens.decided_by_user_id),
        gte(reviewTokens.expires_at, now),
        eq(reviewTokens.is_preview, false),
      ),
    );

  const rows = await db
    .selectDistinct({
      reviewer_id: reviewTokens.created_by_id,
      review_id: reviewTokens.review_id,
      email: reviewers.email,
    })
    .from(reviewTokens)
    .innerJoin(reviews, eq(reviews.id, reviewTokens.review_id))
    .innerJoin(reviewers, eq(reviewers.id, reviewTokens.created_by_id))
    .where(
      and(
        eq(reviewTokens.created_by_kind, "manual"),
        isNull(reviewTokens.revoked_at),
        isNull(reviewTokens.decided_by_email),
        isNull(reviewTokens.decided_by_user_id),
        lt(reviewTokens.expires_at, now),
        eq(reviewTokens.is_preview, false),
        eq(reviews.status, "awaiting_external"),
        sql`${reviewTokens.review_id} NOT IN ${liveTokenReviewIds}`,
      ),
    );

  const byReviewer = new Map<string, { email: string; review_ids: string[] }>();
  for (const r of rows) {
    const entry = byReviewer.get(r.reviewer_id) ?? { email: r.email, review_ids: [] };
    entry.review_ids.push(r.review_id);
    byReviewer.set(r.reviewer_id, entry);
  }

  return Array.from(byReviewer.entries()).map(([reviewer_id, { email, review_ids }]) => ({
    reviewer_id,
    email,
    count: review_ids.length,
    sample_review_ids: review_ids.slice(0, 5),
  }));
}

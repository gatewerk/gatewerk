import { and, isNotNull, isNull, inArray, sql } from "drizzle-orm";
import { reviews } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import type { Priority } from "@gatewerk/shared";
import { EventBus } from "./events";

/**
 * One-shot reminder sweep: find pending reviews that have passed 75% of their
 * timeout window but have not yet expired, stamp `reminder_sent_at`, and emit
 * `review.reminder` for each (routes through PersonalNotifier → in-app ledger
 * row + read-aware email fallback job).
 *
 * The atomic `SET reminder_sent_at = NOW() ... WHERE reminder_sent_at IS NULL
 * ... RETURNING` is itself the once-only guard — a second sweep matches zero
 * rows for an already-reminded review, so no separate claim column is needed.
 * Structurally mirrors `processExpiredChangeRequests` (single UPDATE ...
 * RETURNING, DB-clock authoritative).
 *
 * Predicate:
 *   reminder_sent_at IS NULL                              (once-only guard)
 *   AND expires_at IS NOT NULL AND expires_at > NOW()     (still active)
 *   AND status IN ('pending','awaiting_external')         (not terminal)
 *   AND created_at + (expires_at - created_at) * 0.75 <= NOW()  (>= 75% elapsed)
 */
export async function sweepReminders(db: AppDb, eventBus: EventBus): Promise<number> {
  const rows = await db
    .update(reviews)
    .set({ reminder_sent_at: new Date() })
    .where(
      and(
        isNull(reviews.reminder_sent_at),
        isNotNull(reviews.expires_at),
        sql`${reviews.expires_at} > NOW()`,
        inArray(reviews.status, ["pending", "awaiting_external"]),
        sql`${reviews.created_at} + (${reviews.expires_at} - ${reviews.created_at}) * 0.75 <= NOW()`,
      ),
    )
    .returning({
      id: reviews.id,
      project_id: reviews.project_id,
      template_slug: reviews.template_slug,
      priority: reviews.priority,
      created_at: reviews.created_at,
    });

  for (const row of rows) {
    eventBus.emit("review.reminder", {
      review_id: row.id,
      project_id: row.project_id,
      template: row.template_slug,
      priority: row.priority as Priority,
      created_at: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    });
  }

  if (rows.length > 0) {
    console.log(`Timeout worker: sent ${rows.length} reminder(s) at 75% window`);
  }
  return rows.length;
}

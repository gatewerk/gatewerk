import { sql } from "drizzle-orm";
import { notifications, notificationPreferences, reviewers } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";

export interface NotificationDigestBatch {
  reviewer_id: string;
  email: string;
  unread_count: number;
  sample_titles: string[];
}

/**
 * Returns one batch per reviewer who:
 *   (a) has a notification_preferences row with prefs.digest.enabled === true
 *   (b) has a non-null email (guaranteed by reviewers.email NOT NULL, but we
 *       guard explicitly in WHERE to future-proof nullable migrations)
 *   (c) has at least one unread notification (read_at IS NULL)
 *
 * Returns up to 5 sample titles per batch, ordered newest-first.
 */
export async function computeNotificationDigestBatches(
  db: AppDb,
): Promise<NotificationDigestBatch[]> {
  const rows = await db
    .select({
      reviewer_id: notificationPreferences.reviewer_id,
      email: reviewers.email,
      unread_count: sql<number>`COUNT(*) FILTER (WHERE ${notifications.read_at} IS NULL)`,
      // array_agg of titles for unread rows, newest first; NULL when no unread rows
      sample_titles_raw: sql<string[] | null>`
        array_agg(
          ${notifications.title}
          ORDER BY ${notifications.created_at} DESC
        ) FILTER (WHERE ${notifications.read_at} IS NULL)
      `,
    })
    .from(notificationPreferences)
    .innerJoin(
      reviewers,
      sql`${reviewers.id} = ${notificationPreferences.reviewer_id}`,
    )
    .innerJoin(
      notifications,
      sql`${notifications.reviewer_id} = ${notificationPreferences.reviewer_id}`,
    )
    .where(
      // JSONB predicate: prefs->'digest'->>'enabled' cast to boolean must be true
      sql`(${notificationPreferences.prefs}->'digest'->>'enabled')::boolean = true
          AND ${reviewers.email} IS NOT NULL`,
    )
    .groupBy(notificationPreferences.reviewer_id, reviewers.email)
    .having(
      sql`COUNT(*) FILTER (WHERE ${notifications.read_at} IS NULL) > 0`,
    );

  return rows.map((row) => ({
    reviewer_id: row.reviewer_id,
    email: row.email,
    unread_count: Number(row.unread_count),
    sample_titles: (row.sample_titles_raw ?? []).slice(0, 5),
  }));
}

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Single-row singleton table gating the daily notification digest job
// (oss.notification-digest pg-boss queue). Mirrors jobs_daily_digest_state
// but is kept separate so each digest can advance its own last_run_at
// without sharing the CHECK-constrained 'singleton' row of the other table.
export const jobsNotificationDigestState = pgTable("jobs_notification_digest_state", {
  id: text("id").primaryKey(),
  last_run_at: timestamp("last_run_at", { withTimezone: true }).notNull(),
});

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Single-row table — primary key constraint pins id to the literal 'singleton'.
// last_run_at is the "did we attempt today's batch" gate the daily-digest
// job handler locks via SELECT … FOR UPDATE before computing batches.
export const jobsDailyDigestState = pgTable("jobs_daily_digest_state", {
  id: text("id").primaryKey(),
  last_run_at: timestamp("last_run_at", { withTimezone: true }).notNull(),
});

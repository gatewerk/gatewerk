import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  cloud_config: jsonb("cloud_config"), // null = OSS, populated = cloud (billing, plan, limits)
  stripe_customer_id: text("stripe_customer_id").unique(),
  billing_email: text("billing_email"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  email_paused_at: timestamp("email_paused_at", { withTimezone: true }),
  email_pause_reason: text("email_pause_reason"),
  /** Set by resumeTenant whenever an operator clears a pause. Lets the hourly
   *  evaluator clamp its lookback window per tenant so stale pre resume rows
   *  cannot re trigger the same breach with zero new sends. Null forever for
   *  a tenant that has never been paused, or never resumed. */
  email_resumed_at: timestamp("email_resumed_at", { withTimezone: true }),
});

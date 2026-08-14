import { pgTable, text, timestamp, date, integer, boolean, smallint } from "drizzle-orm/pg-core";

export const accountTombstones = pgTable("account_tombstones", {
  id: text("id").primaryKey(),
  deleted_at: timestamp("deleted_at", { withTimezone: true }).defaultNow().notNull(),
  signup_cohort: date("signup_cohort").notNull(),
  churn_cohort: date("churn_cohort").notNull(),
  plan_at_churn: text("plan_at_churn").notNull(),
  mrr_cents: integer("mrr_cents").notNull().default(0),
  ltv_cents: integer("ltv_cents").notNull().default(0),
  trial_converted: boolean("trial_converted").notNull(),
  trial_days: smallint("trial_days"),
  account_age_days: integer("account_age_days").notNull(),
  reviews_created: integer("reviews_created").notNull().default(0),
  api_calls_total: integer("api_calls_total").notNull().default(0),
  templates_created: integer("templates_created").notNull().default(0),
  tokens_generated: integer("tokens_generated").notNull().default(0),
  completed_onboarding: boolean("completed_onboarding").notNull().default(false),
  reached_first_review: boolean("reached_first_review").notNull().default(false),
  reached_first_approval: boolean("reached_first_approval").notNull().default(false),
  upgraded_from_trial: boolean("upgraded_from_trial").notNull().default(false),
  deletion_reason: text("deletion_reason").notNull(),
});

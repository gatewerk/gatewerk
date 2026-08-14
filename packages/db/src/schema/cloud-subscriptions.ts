import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { SubscriptionPlan, SubscriptionStatus } from "@gatewerk/shared";
import { organizations } from "./organizations";

export const cloudSubscriptions = pgTable("cloud_subscriptions", {
  id: text("id").primaryKey(),
  organization_id: text("organization_id").notNull().unique().references(() => organizations.id, { onDelete: "cascade" }),
  stripe_subscription_id: text("stripe_subscription_id").unique(),
  stripe_price_id: text("stripe_price_id"),
  plan: text("plan").$type<SubscriptionPlan>().notNull(),
  status: text("status").$type<SubscriptionStatus>().notNull(),
  last_event_at: timestamp("last_event_at", { withTimezone: true }),
  trial_ends_at: timestamp("trial_ends_at", { withTimezone: true }),
  current_period_start: timestamp("current_period_start", { withTimezone: true }),
  current_period_end: timestamp("current_period_end", { withTimezone: true }),
  cancel_at: timestamp("cancel_at", { withTimezone: true }),
  canceled_at: timestamp("canceled_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  last_dunning_sent_at: timestamp("last_dunning_sent_at", { withTimezone: true }),
}, (t) => [
  index("cloud_subscriptions_status_trial_idx")
    .on(t.status, t.trial_ends_at)
    .where(sql`${t.trial_ends_at} IS NOT NULL`),
]);

import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  event_id: text("event_id").primaryKey(),
  event_type: text("event_type").notNull(),
  processed_at: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
  payload: jsonb("payload"),
});

import { pgTable, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { reviews } from "./reviews";

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  review_id: text("review_id").notNull().references(() => reviews.id, { onDelete: "cascade" }),
  event_type: text("event_type").notNull(), // review.decided, review.retried, review.expired
  url: text("url").notNull(),
  payload: jsonb("payload").notNull(),
  // hmac_secret column dropped in migration 057. Retry worker JOINs
  // webhook_deliveries → reviews → projects to fetch the
  // CURRENT projects.hmac_secret at attempt time instead.
  status: text("status").notNull().default("pending"), // pending, delivered, failed
  attempts: integer("attempts").notNull().default(0),
  max_attempts: integer("max_attempts").notNull().default(5),
  last_attempt_at: timestamp("last_attempt_at", { withTimezone: true }),
  next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }),
  last_error: text("last_error"),
  delivered_at: timestamp("delivered_at", { withTimezone: true }),
  claimed_by: text("claimed_by"),
  claimed_at: timestamp("claimed_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

import { pgTable, text, timestamp, integer, numeric, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const meterEventQueue = pgTable("meter_event_queue", {
  id: text("id").primaryKey(),
  stripe_customer_id: text("stripe_customer_id").notNull(),
  event_name: text("event_name").notNull(),
  value: numeric("value").notNull(),
  event_timestamp: timestamp("event_timestamp", { withTimezone: true }).notNull(),
  idempotency_key: text("idempotency_key").notNull().unique(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  attempts: integer("attempts").notNull().default(0),
  last_attempt_at: timestamp("last_attempt_at", { withTimezone: true }),
  last_error: text("last_error"),
  status: text("status").$type<"pending" | "sent" | "failed">().notNull().default("pending"),
}, (t) => [
  index("idx_meter_event_queue_pending").on(t.status).where(sql`${t.status} = 'pending'`),
  index("idx_meter_event_queue_customer").on(t.stripe_customer_id, t.created_at),
]);

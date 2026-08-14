import { pgTable, text, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";
import { projects } from "./projects";

export const notificationChannels = pgTable("notification_channels", {
  id: text("id").primaryKey(),
  project_id: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  webhook_url: text("webhook_url").notNull(),
  events: jsonb("events").notNull(),
  headers: jsonb("headers"),
  is_active: boolean("is_active").default(true).notNull(),
  type: text("type").notNull().default("generic"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  // Written by NotificationService (services/notifications.ts) after every
  // fire-and-forget delivery attempt — the only record of whether this
  // channel is actually reachable. last_error is cleared on a success.
  last_delivery_at: timestamp("last_delivery_at", { withTimezone: true }),
  last_delivery_status: text("last_delivery_status"),
  last_error: text("last_error"),
});

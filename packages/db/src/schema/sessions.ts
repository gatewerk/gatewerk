import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  reviewer_id: text("reviewer_id").notNull(),
  jti: text("jti").notNull().unique(),
  ip_address: text("ip_address"),
  user_agent: text("user_agent"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  last_active_at: timestamp("last_active_at", { withTimezone: true }).defaultNow().notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  revoked_at: timestamp("revoked_at", { withTimezone: true }),
});

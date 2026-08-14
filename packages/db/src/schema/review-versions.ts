import { pgTable, text, jsonb, timestamp, integer } from "drizzle-orm/pg-core";
import { reviews } from "./reviews";

export const reviewVersions = pgTable("review_versions", {
  id: text("id").primaryKey(),
  review_id: text("review_id").notNull().references(() => reviews.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  payload: jsonb("payload").notNull(),
  feedback: text("feedback"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

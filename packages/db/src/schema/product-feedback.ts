import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { projects } from "./projects";

export const productFeedback = pgTable("product_feedback", {
  id: text("id").primaryKey(),
  project_id: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  context: jsonb("context"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

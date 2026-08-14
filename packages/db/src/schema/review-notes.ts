import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { reviews } from "./reviews";

export const reviewNotes = pgTable("review_notes", {
  id: text("id").primaryKey(),
  review_id: text("review_id").notNull().references(() => reviews.id, { onDelete: "cascade" }),
  author: text("author").notNull(),
  content: text("content").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("review_notes_review_id_idx").on(t.review_id),
]);

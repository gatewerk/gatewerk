import { pgTable, text, timestamp, index, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { notes } from "./notes";
import { reviewers } from "./reviewers";

// Table-level CHECK on target_kind mirrors migration 027-notes-layer.sql:38.
// SQL is canonical for prod (M0 applies migrations); this declaration matters
// for fresh DBs bootstrapped via `pnpm drizzle-kit push`, where without it
// any string would be accepted.
export const noteAttachments = pgTable("note_attachments", {
  id: text("id").primaryKey(),
  note_id: text("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  target_kind: text("target_kind").notNull(),
  target_id: text("target_id").notNull(),
  attached_by: text("attached_by").references(() => reviewers.id, { onDelete: "set null" }),
  attached_at: timestamp("attached_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("note_attachments_target_idx").on(t.target_kind, t.target_id),
  index("note_attachments_note_idx").on(t.note_id),
  unique("note_attachments_unique").on(t.note_id, t.target_kind, t.target_id),
  check(
    "note_attachments_target_kind_chk",
    sql`${t.target_kind} IN ('review', 'template', 'chain_run')`,
  ),
]);

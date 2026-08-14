import { pgTable, text, boolean, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects";
import { reviewers } from "./reviewers";

// Partial-WHERE + GIN-on-tags brought into Drizzle to match migration
// 027-notes-layer.sql verbatim. The SQL migration is canonical for prod (M0
// pipeline applies SQL files, not Drizzle); these declarations matter for
// fresh staging DBs bootstrapped via `pnpm drizzle-kit push`, where the
// partial predicate keeps the index lean (deleted notes excluded) and the
// GIN tags index supports the AND-filter list query.
export const notes = pgTable("notes", {
  id: text("id").primaryKey(),
  project_id: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  author_id: text("author_id").references(() => reviewers.id, { onDelete: "set null" }),
  author_display_fallback: text("author_display_fallback"),
  body: text("body").notNull(),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  is_shared: boolean("is_shared").notNull().default(false),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  index("notes_project_shared_idx")
    .on(t.project_id, t.is_shared, t.created_at.desc())
    .where(sql`${t.deleted_at} IS NULL`),
  index("notes_author_idx")
    .on(t.project_id, t.author_id, t.created_at.desc())
    .where(sql`${t.deleted_at} IS NULL`),
  index("notes_tags_idx")
    .using("gin", t.tags)
    .where(sql`${t.deleted_at} IS NULL`),
  // Table-level CHECK mirrors migration 027-notes-layer.sql:17-19. Every
  // note must carry either a real author_id (session subject) or an
  // author_display_fallback string (api_key / legacy backfill). Without
  // this constraint, fresh DBs bootstrapped via `pnpm drizzle-kit push`
  // accept notes with both fields NULL — write.ts then surfaces them as
  // "Unknown" with no provenance.
  check(
    "notes_author_present",
    sql`${t.author_id} IS NOT NULL OR ${t.author_display_fallback} IS NOT NULL`,
  ),
]);

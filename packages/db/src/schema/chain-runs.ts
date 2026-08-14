import { pgTable, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { projects } from "./projects";
import { templates } from "./templates";

export const chainRuns = pgTable("chain_runs", {
  id: text("id").primaryKey(),
  project_id: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  template_id: text("template_id").references(() => templates.id, { onDelete: "set null" }),
  name: text("name"),
  mode: text("mode").notNull().default("sequential"),
  rejection_policy: text("rejection_policy").notNull().default("terminate"),
  status: text("status").notNull().default("active"),
  metadata: jsonb("metadata"),
  created_by: text("created_by").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completed_at: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  // Dashboard listing + project-scoped scans. The partial (status='active')
  // variant lives in migration 022; drizzle-kit cannot declare partial
  // predicates so the SQL migration is authoritative.
  index("chain_runs_project_id_idx").on(t.project_id, t.created_at.desc()),
  index("chain_runs_active_idx").on(t.project_id, t.created_at.desc()),
]);

import { pgTable, text, jsonb, timestamp, index, uniqueIndex, boolean, integer, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects";

export const templates = pgTable("templates", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  project_id: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  fields: jsonb("fields").notNull(),
  actions: jsonb("actions").notNull().default(["approve", "reject"]),
  default_priority: text("default_priority").notNull().default("normal"),
  enable_review_links: boolean("enable_review_links").notNull().default(false),
  auto_approve: boolean("auto_approve").notNull().default(false),
  timeout_seconds: integer("timeout_seconds"),
  timeout_action: text("timeout_action"),
  changes_timeout_hours: integer("changes_timeout_hours"),
  instructions: text("instructions"),
  // Per-template gates. Default TRUE preserves legacy "all features on".
  //
  // allow_request_changes is enforced SERVER-SIDE: execute-action.ts refuses
  // any iteration-kind action when it is false. There is no editor toggle
  // for either flag yet. Both are settable over the API only.
  allow_request_changes: boolean("allow_request_changes").notNull().default(true),
  allow_notes: boolean("allow_notes").notNull().default(true),
  // HOTL monitoring gate (migration 072). Human-authored opt-in: agents may
  // request oversight='monitoring' ONLY against templates with this flag on.
  // Default FALSE — a lying agent needs a complicit human, not just a label.
  allow_monitoring: boolean("allow_monitoring").notNull().default(false),
  // Spec section 8.5. Pre-fill defaults read by ShareViaLinkDialog at open
  // so reviewers don't have to re-pick auth tier and expiry on every link.
  // CHECK constraints enforced at storage layer via migration 039.
  default_auth_level: text("default_auth_level").notNull().default("public"),
  default_expiry_seconds: integer("default_expiry_seconds").notNull().default(86400),
  status: text("status").notNull().default("active"),
  draft_config: jsonb("draft_config"),
  draft_updated_at: timestamp("draft_updated_at", { withTimezone: true }),
  chain_config: jsonb("chain_config"),
  // v1 agent primitives (migration 070). Template-level default for the
  // max_iterations guardrail — inherited by reviews when the per-review field
  // is absent. TimeoutWorker closes awaiting_iteration reviews that hit this cap.
  max_iterations: integer("max_iterations"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // Templates list, default and per-status filtering ordered by recency.
  // Supersedes the previous (project_id) prefix-only index.
  index("templates_project_id_status_created_at_idx").on(t.project_id, t.status, t.created_at.desc()),
  // Table-level CHECK on status mirrors migration 028. Canonical value set
  // is TEMPLATE_STATUSES in
  // packages/shared/src/index.ts.
  check("templates_status_chk", sql`${t.status} IN ('draft', 'active', 'inactive')`),
  // max_iterations positivity guard (migration 070). Mirrors the reviews-side
  // CHECK; a 0/negative template default would poison every inheriting review.
  check("templates_max_iterations_positive_chk", sql`${t.max_iterations} IS NULL OR ${t.max_iterations} >= 1`),
  // Storage-level guard against concurrent creates with identical
  // (project_id, slug). Migration 055.
  uniqueIndex("templates_project_id_slug_uniq").on(t.project_id, t.slug),
]);

import { pgTable, text, jsonb, timestamp, integer, real, boolean, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects";
import { templates } from "./templates";

export const reviews = pgTable("reviews", {
  id: text("id").primaryKey(),
  project_id: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  template_id: text("template_id").references(() => templates.id, { onDelete: "set null" }),
  template_slug: text("template_slug").notNull(),
  payload: jsonb("payload").notNull(),
  suggested_value: jsonb("suggested_value"),
  approved_value: jsonb("approved_value"),
  callback_url: text("callback_url"),
  priority: text("priority").notNull().default("normal"),
  actions: jsonb("actions").notNull().default(["approve", "reject"]),
  confidence: real("confidence"),
  irreversibility: text("irreversibility"),
  // HOTL monitoring gate (migration 072). 'blocking' = agent waits for the
  // decision; 'monitoring' = agent already acted, human may veto/confirm
  // within the expires_at window. Canonical value set: OVERSIGHT_MODES in
  // packages/shared/src/enums.ts.
  oversight: text("oversight").notNull().default("blocking"),
  assignee: text("assignee"),
  metadata: jsonb("metadata"),
  timeout_action: text("timeout_action"),
  timeout_seconds: integer("timeout_seconds"),
  expires_at: timestamp("expires_at", { withTimezone: true }),
  status: text("status").notNull().default("pending"),
  decision: text("decision"),
  edited_payload: jsonb("edited_payload"),
  feedback: text("feedback"),
  prompt_edit: text("prompt_edit"),
  decided_by: text("decided_by"),
  // Whether `decided_by` names someone who was actually confirmed. FALSE only
  // for a public review link, whose decider is the label the SHARER typed and
  // nobody checked. NULL means no claim (undecided, or decided before
  // migration 087) and must never be read as "unverified".
  decided_by_verified: boolean("decided_by_verified"),
  decided_at: timestamp("decided_at", { withTimezone: true }),
  // Last-action context (M-configurable-actions Phase 1, migration 031).
  // Surfaces the most recent action invocation for inbox badges and audit
  // joins without traversing the full audit log. last_action_kind is
  // CHECK-bounded to ACTION_KINDS (decision | iteration | side_effect);
  // backfill for historical decided rows lands in migration 032.
  last_action_id: text("last_action_id"),
  last_action_kind: text("last_action_kind"),
  last_action_at: timestamp("last_action_at", { withTimezone: true }),
  last_action_by: text("last_action_by"),
  current_version: integer("current_version").notNull().default(1),
  claimed_by: text("claimed_by"),
  claimed_at: timestamp("claimed_at", { withTimezone: true }),
  draft_payload: jsonb("draft_payload"),
  draft_by: text("draft_by"),
  draft_at: timestamp("draft_at", { withTimezone: true }),
  // Human workflow primitives (v1, migration 071). `held_by` is the human
  // soft-lock (distinct from `claimed_by` which is the worker's transient
  // lease). `snoozed_until` pauses the SLA; enforced by the worker guard.
  held_by: text("held_by"),
  held_at: timestamp("held_at", { withTimezone: true }),
  snoozed_until: timestamp("snoozed_until", { withTimezone: true }),
  action_value: text("action_value"),
  action_label: text("action_label"),
  // Assignment ladder (M9 Phase 1). `assignment_ladder` holds an ordered
  // array of { actor, trigger_after_seconds, status } steps; `ladder_index`
  // points at the currently-active step; `ladder_next_promote_at` is the
  // timer target for the next promotion (null when there is no ladder or
  // the ladder has reached its final step). See migration 021 and
  // `AssignmentLadderService` for the promotion arithmetic.
  assignment_ladder: jsonb("assignment_ladder"),
  ladder_index: integer("ladder_index").notNull().default(0),
  ladder_next_promote_at: timestamp("ladder_next_promote_at", { withTimezone: true }),
  // Chain engine back-pointers (M10). Null for standalone reviews; populated
  // at step materialisation. `prev_step_ids` records the review IDs of the
  // dependency set (empty array on step 1) so `chain.completed` can rebuild
  // the full transcript with a single indexed lookup per step.
  chain_run_id: text("chain_run_id"),
  chain_step_id: text("chain_step_id"),
  prev_step_ids: jsonb("prev_step_ids"),
  idempotency_key: text("idempotency_key"),
  // v1 agent primitives (migration 070). trace_url is an optional https-only
  // deep link to the originating agent trace session for observability.
  // max_iterations caps the number of revision rounds before TimeoutWorker
  // auto-closes the review as decided/max_iterations_reached.
  trace_url: text("trace_url"),
  max_iterations: integer("max_iterations"),
  // P8 snapshot (migration 073): normalized field schema captured at creation.
  // Nullable — legacy rows fall back to the live template join.
  template_fields: jsonb("template_fields"),
  // Reminder sweep idempotency guard (migration 077). Set by the once-only
  // reminder job to prevent duplicate emails on repeated sweeps.
  reminder_sent_at: timestamp("reminder_sent_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // Inbox list, default and per-status filtering. Trailing created_at supports
  // ORDER BY when the priority bucket collapses to a single value.
  index("reviews_project_id_status_created_at_idx").on(t.project_id, t.status, t.created_at.desc()),
  // Inbox list filtered by template_slug (UI filter pill).
  index("reviews_project_id_template_slug_created_at_idx").on(t.project_id, t.template_slug, t.created_at.desc()),
  // Inbox list filtered by assignee (column is `assignee`, not `assigned_to`).
  index("reviews_project_id_assignee_created_at_idx").on(t.project_id, t.assignee, t.created_at.desc()),
  index("reviews_expires_at_idx").on(t.expires_at),
  // Ladder-promotion claim query; partial via migration 021 (drizzle-kit
  // schema declarations here do not emit the WHERE clause, the SQL migration
  // is the source of truth for the partial predicate).
  index("reviews_ladder_next_promote_at_idx").on(t.ladder_next_promote_at),
  // Chain context lookup (M10). Partial predicate (chain_run_id IS NOT NULL)
  // lives in migration 022; drizzle cannot emit it here.
  index("reviews_chain_run_id_idx").on(t.chain_run_id),
  // Idempotency key lookup (migration 069). Partial WHERE (idempotency_key IS
  // NOT NULL) lives in the migration; drizzle-kit cannot emit partial indexes.
  index("reviews_project_id_idempotency_key_idx").on(t.project_id, t.idempotency_key),
  // Human workflow primitives (v1, migration 071). Partial predicates live
  // in the migration; drizzle index declarations are plain (mirror pattern).
  index("reviews_held_by_idx").on(t.held_by),
  index("reviews_snoozed_until_idx").on(t.snoozed_until),
  // CHECK constraints on enum-shaped columns — status was covered by
  // migration 025; priority + decision land in migration 028. Mirrored
  // here so fresh DBs bootstrapped via
  // `pnpm drizzle-kit push` get the same defense-in-depth as prod.
  // Canonical value sets are PRIORITIES + DECISIONS in
  // packages/shared/src/enums.ts.
  check("reviews_priority_chk", sql`${t.priority} IN ('low', 'normal', 'high', 'critical')`),
  // Status CHECK (established migration 033/035, extended 072). Mirrors
  // REVIEW_STATUSES in packages/shared/src/enums.ts.
  check(
    "reviews_status_chk",
    sql`${t.status} IN ('pending', 'awaiting_iteration', 'awaiting_external', 'decided', 'expired', 'archived', 'monitoring')`,
  ),
  // trace_url https-only guard (migration 070). Defense-in-depth mirror of the
  // Zod .refine and route-layer check so even direct DB writes are guarded.
  check("reviews_trace_url_https_chk", sql`${t.trace_url} IS NULL OR ${t.trace_url} LIKE 'https://%'`),
  // max_iterations positivity guard (migration 070). A 0/negative cap would
  // make `current_version > max_iterations` always true → instant close.
  check("reviews_max_iterations_positive_chk", sql`${t.max_iterations} IS NULL OR ${t.max_iterations} >= 1`),
  check(
    "reviews_decision_chk",
    sql`${t.decision} IS NULL OR ${t.decision} IN ('approved', 'rejected', 'edited', 'retried', 'expired', 'max_iterations_reached', 'confirmed', 'vetoed')`,
  ),
  // Oversight CHECK (migration 072). Mirrors OVERSIGHT_MODES.
  check("reviews_oversight_chk", sql`${t.oversight} IN ('blocking', 'monitoring')`),
  // last_action_kind CHECK (configurable-actions Phase 1, migration 031).
  // Mirrors ACTION_KINDS from packages/shared/src/enums.ts so fresh DBs
  // bootstrapped via drizzle-kit push get the same defense-in-depth as prod.
  check(
    "reviews_last_action_kind_chk",
    sql`${t.last_action_kind} IS NULL OR ${t.last_action_kind} IN ('decision', 'iteration', 'side_effect')`,
  ),
]);

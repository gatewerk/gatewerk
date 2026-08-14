import { pgTable, text, jsonb, timestamp, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { chainRuns } from "./chain-runs";
import { reviews } from "./reviews";

export const chainSteps = pgTable("chain_steps", {
  id: text("id").primaryKey(),
  chain_run_id: text("chain_run_id").notNull().references(() => chainRuns.id, { onDelete: "cascade" }),
  step_number: integer("step_number").notNull(),
  review_id: text("review_id").references(() => reviews.id, { onDelete: "set null" }),
  assignee_spec: jsonb("assignee_spec").notNull(),
  depends_on: jsonb("depends_on"),
  status: text("status").notNull().default("pending"),
  materialized_at: timestamp("materialized_at", { withTimezone: true }),
  // M13 (migration 023): per-step rejection disposition. NULL → 'abort'
  // semantics at the engine layer (preserves pre-M13 behaviour). CHECK
  // constraints enforce the enum + the branch-target-precedes-current
  // invariant at the DB; zod enforces the same rules at createRun time.
  rejection_policy: text("rejection_policy"),
  rejection_branch_to: integer("rejection_branch_to"),
}, (t) => [
  uniqueIndex("chain_steps_chain_run_id_step_number_unique").on(t.chain_run_id, t.step_number),
  index("chain_steps_chain_run_id_idx").on(t.chain_run_id, t.step_number),
]);

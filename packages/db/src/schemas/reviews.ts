// Zod schemas derived from the `reviews` Drizzle table via drizzle-zod.
// These are the single source of truth for review insert/select shape.
// Import from "@gatewerk/db/schemas" — do not redefine shapes elsewhere.
//
// Omissions on insertReviewSchema:
//   id, created_at, updated_at — server-generated
//   status, decision — server-controlled state machine
//   decided_by, decided_by_verified, decided_at, last_action_* — set by
//     decision handlers
//   current_version — server-managed counter
//   chain_run_id, chain_step_id, prev_step_ids — chain engine internal
//   ladder_index, ladder_next_promote_at — ladder engine internal
//   claimed_by, claimed_at, draft_* — reviewer-only fields
//   suggested_value, approved_value, edited_payload — derived from reviewer decisions
//   feedback, prompt_edit — reviewer authoring; not caller-supplied
//   expires_at — server-derived from timeout policy
//   assignment_ladder — assignment engine internal
//
// `template_id` is intentionally caller-supplied: tenants may set it directly
// for cross-template chain wiring; standard create flow resolves it from
// `template_slug`.

import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { reviews } from "../schema/reviews";

export const insertReviewSchema = createInsertSchema(reviews).omit({
  id: true,
  status: true,
  decision: true,
  decided_by: true,
  // Written by the same decision handler as decided_by (migration 087). Left
  // caller-suppliable, a create call could assert `decided_by_verified: true`
  // on a review nobody has decided — a verification claim with nothing behind
  // it, in the one column whose entire job is to say whether to trust the name.
  decided_by_verified: true,
  decided_at: true,
  last_action_id: true,
  last_action_kind: true,
  last_action_at: true,
  last_action_by: true,
  current_version: true,
  chain_run_id: true,
  chain_step_id: true,
  prev_step_ids: true,
  ladder_index: true,
  ladder_next_promote_at: true,
  claimed_by: true,
  claimed_at: true,
  draft_payload: true,
  draft_by: true,
  draft_at: true,
  action_value: true,
  action_label: true,
  assignment_ladder: true,
  created_at: true,
  updated_at: true,
  suggested_value: true,
  approved_value: true,
  edited_payload: true,
  feedback: true,
  prompt_edit: true,
  expires_at: true,
  // P8 snapshot (migration 073): server-computed from the template at
  // creation — agents must never supply it.
  template_fields: true,
  // Reminder stamp (migration 077): written only by the reminder worker,
  // under an atomic `WHERE reminder_sent_at IS NULL` once-only guard.
  // Caller-supplied values would silently suppress the reminder.
  reminder_sent_at: true,
});

export const selectReviewSchema = createSelectSchema(reviews);

// Zod 4 phantom-property: `typeof schema.type` ≡ `z.infer<typeof schema>`.
// The `.type` form is shorter and equivalent for inferring runtime output.
export type InsertReview = typeof insertReviewSchema.type;
export type SelectReview = typeof selectReviewSchema.type;

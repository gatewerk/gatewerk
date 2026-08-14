/**
 * Chain webhook payload builders (extracted from WebhookService to keep
 * webhooks.ts within the 600-logical-line cap). Every type here mirrors the
 * parameter shape of the corresponding sender method; they are exported for
 * call-site type safety and tested indirectly via the chain webhook test
 * suite.
 */

export interface SendChainNextStepReadyData {
  callback_url: string;
  hmac_secret: string;
  chain_run_id: string;
  step_number: number;
  step_id: string;
  step_name?: string | null;
  previous_step_id: string | null;
  next_review_id: string;
  external_token_url?: string;
  assignee: Record<string, unknown>;
  created_at: string;
  request_id?: string;
}

export interface SendChainCompletedData {
  callback_url: string;
  hmac_secret: string;
  chain_run_id: string;
  final_review_id: string;
  /** The step-1 review, which is the id the requester was handed at creation. */
  initial_review_id?: string | null;
  /** The final step's own verdict. See the note on the builder. */
  final_decision?: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
  approved_value?: Record<string, unknown> | null;
  edited_payload?: Record<string, unknown> | null;
  was_edited?: boolean;
  iteration_count?: number;
  completed_at: string;
  rejection_policy: string;
  metadata: Record<string, unknown> | null;
  transcript: Array<Record<string, unknown>>;
  request_id?: string;
}

export interface SendChainRejectedData {
  callback_url: string;
  hmac_secret: string;
  chain_run_id: string;
  initial_review_id?: string | null;
  rejected_at: string;
  rejection_policy: string;
  rejecting_step_id: string;
  rejecting_step_number: number;
  rejecting_review_id: string;
  rejection_feedback: string | null;
  transcript: Array<Record<string, unknown>>;
  request_id?: string;
}

export interface SendChainStepRejectedData {
  callback_url: string;
  hmac_secret: string;
  chain_run_id: string;
  step_index: number;
  applied_policy: "abort" | "continue" | "branch";
  next_step_index: number | null;
  rejecting_review_id: string;
  rejection_feedback?: string | null;
  request_id?: string;
}

export interface SendChainStepHaltedData {
  callback_url: string;
  hmac_secret: string;
  chain_run_id: string;
  review_id: string;
  reason: string;
  code?: string;
  request_id?: string;
}

export interface SendChainAbortedData {
  callback_url: string;
  hmac_secret: string;
  chain_run_id: string;
  anchor_review_id: string;
  initial_review_id?: string | null;
  aborted_by: string;
  skipped_step_count: number;
  request_id?: string;
}

export function buildChainNextStepReadyPayload(
  data: SendChainNextStepReadyData,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: "chain.next_step_ready",
    chain_run_id: data.chain_run_id,
    step_number: data.step_number,
    step_id: data.step_id,
    previous_step_id: data.previous_step_id,
    next_review_id: data.next_review_id,
    assignee: data.assignee,
    created_at: data.created_at,
  };
  if (data.step_name) payload.step_name = data.step_name;
  if (data.external_token_url) payload.external_token_url = data.external_token_url;
  return payload;
}

/**
 * The chain authorized. C1 made this THE authorization signal for a chain
 * (review.decided is withheld for chain-attached reviews), and that promotion
 * carries three obligations this payload now meets.
 *
 * It NAMES its reviews. `final_review_id` was declared on the input type and
 * passed by the caller from the beginning, and then dropped here — so the one
 * event that says "you may act" could not be correlated to any review the
 * requester had ever seen. `initial_review_id` is the step-1 review, which is
 * the id the requester was actually handed at creation.
 *
 * It carries what was AUTHORIZED. The engine forwards approved_value step to
 * step, so after any reviewer edit the authorized object is not the payload the
 * agent submitted. Without these fields an agent could not learn what it had
 * been authorized to execute without a round trip.
 *
 * It states `final_decision`. Under rejection_policy='continue' a rejected
 * FINAL step still reaches completeRun, so chain.completed can fire over a
 * rejected last step. 'continue' is held back at launch, so this is a guard and
 * not a live bug — but "chain.completed means authorized" is now a documented
 * sentence, and it must not quietly become false on the day 'continue' ships.
 */
export function buildChainCompletedPayload(
  data: SendChainCompletedData,
): Record<string, unknown> {
  return {
    type: "chain.completed",
    chain_run_id: data.chain_run_id,
    status: "completed",
    final_review_id: data.final_review_id,
    initial_review_id: data.initial_review_id ?? null,
    final_decision: data.final_decision ?? null,
    decided_by: data.decided_by ?? null,
    decided_at: data.decided_at ?? null,
    approved_value: data.approved_value ?? null,
    edited_payload: data.edited_payload ?? null,
    was_edited: data.was_edited ?? false,
    iteration_count: data.iteration_count,
    completed_at: data.completed_at,
    rejection_policy: data.rejection_policy,
    metadata: data.metadata,
    transcript: data.transcript,
  };
}

export function buildChainRejectedPayload(
  data: SendChainRejectedData,
): Record<string, unknown> {
  return {
    type: "chain.rejected",
    chain_run_id: data.chain_run_id,
    status: "rejected",
    initial_review_id: data.initial_review_id ?? null,
    rejected_at: data.rejected_at,
    rejection_policy: data.rejection_policy,
    rejecting_step_id: data.rejecting_step_id,
    rejecting_step_number: data.rejecting_step_number,
    rejecting_review_id: data.rejecting_review_id,
    rejection_feedback: data.rejection_feedback,
    transcript: data.transcript,
  };
}

export function buildChainStepRejectedPayload(
  data: SendChainStepRejectedData,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: "chain.step_rejected",
    chain_run_id: data.chain_run_id,
    step_index: data.step_index,
    applied_policy: data.applied_policy,
    next_step_index: data.next_step_index,
    rejecting_review_id: data.rejecting_review_id,
  };
  if (data.rejection_feedback !== undefined) {
    payload.rejection_feedback = data.rejection_feedback;
  }
  return payload;
}

export function buildChainStepHaltedPayload(
  data: SendChainStepHaltedData,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: "chain.step_halted",
    chain_run_id: data.chain_run_id,
    review_id: data.review_id,
    reason: data.reason,
  };
  if (data.code) payload.code = data.code;
  return payload;
}

export function buildChainAbortedPayload(
  data: SendChainAbortedData,
): Record<string, unknown> {
  return {
    type: "chain.aborted",
    chain_run_id: data.chain_run_id,
    status: "aborted",
    // Declared on the input type and passed by the caller since M10, then
    // dropped here — which left chain.aborted the only terminal chain event
    // with no review correlator on the wire AND no transcript to recover one
    // from. A consumer suspended against a review id could not act on it.
    anchor_review_id: data.anchor_review_id,
    initial_review_id: data.initial_review_id ?? null,
    aborted_by: data.aborted_by,
    skipped_step_count: data.skipped_step_count,
  };
}

export interface SendChainStepDecidedData {
  callback_url: string;
  hmac_secret: string;
  chain_run_id: string;
  step_index: number;
  review_id: string;
  decision: string;
  decided_by: string | null;
  decided_at: string;
  feedback?: string | null;
  edited_payload?: Record<string, unknown> | null;
  approved_value?: Record<string, unknown> | null;
  action?: { id?: string; label?: string } | null;
  request_id?: string;
}

/**
 * One step of a route decided. Replaces review.decided for chain-attached
 * reviews (C1, charter §5.1 — see the contract note on sendDecision).
 *
 * Deliberately carries NO `total_steps` and NO `is_final`, and no other field
 * from which finality could be inferred. Finality is not knowable here: this
 * fires from the decision-dispatch path, before ChainEngine has handled the
 * decision at all. And `total_steps` is a chain_steps row count while the
 * `branch` rejection policy resets later rows to 'pending' IN PLACE and re-runs
 * them, so `step_index === total_steps` is true of a step that will decide
 * again. Shipping both operands would hand every consumer that bad inference.
 * Only chain.completed / chain.rejected / chain.aborted state termination.
 *
 * Fired from the dispatch path rather than from the engine on purpose. The
 * engine's handlers return early when the run is no longer active
 * (chainRunStillActive) and swallow their own exceptions into chain.step_halted,
 * so an engine-fired step event would go silent on a concurrent abort, on an
 * engine exception, and on the final step (which reaches completeRun and never
 * materialises a next step). Those are the paths an operator most needs to see.
 */
export function buildChainStepDecidedPayload(
  data: SendChainStepDecidedData,
): Record<string, unknown> {
  return {
    type: "chain.step_decided",
    chain_run_id: data.chain_run_id,
    step_index: data.step_index,
    review_id: data.review_id,
    decision: data.decision,
    decided_by: data.decided_by,
    decided_at: data.decided_at,
    feedback: data.feedback ?? null,
    edited_payload: data.edited_payload ?? null,
    approved_value: data.approved_value ?? null,
    action: data.action ?? null,
  };
}

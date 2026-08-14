/**
 * Canonical classifier for every webhook Gatewerk can POST to a review's
 * `callback_url`.
 *
 * WHY THIS EXISTS
 * ---------------
 * A review's `callback_url` is not a "decision" channel — it is the review's
 * entire event feed. `apps/api/src/services/webhooks.ts` and
 * `apps/api/src/services/webhooks/chain-payloads.ts` between them deliver
 * sixteen distinct event types to it. Two structural traps make naive parsing
 * unsafe:
 *
 *   1. NOT EVERY EVENT CARRIES A `type` KEY. `review.action_taken`
 *      (services/reviews/actions.ts:275-298) and operator-authored iteration
 *      events (actions.ts:332-344) use `event` instead. Reading only `type`
 *      yields `undefined`, and any "else treat it as a decision" fallback then
 *      resumes the caller's workflow with `decision: undefined`.
 *
 *   2. NOT EVERY EVENT IS KEYED BY `review_id`. `chain.next_step_ready` uses
 *      `next_review_id`; `chain.rejected` and `chain.step_rejected` use
 *      `rejecting_review_id`; `chain.completed` uses `final_review_id` and
 *      `chain.aborted` uses `anchor_review_id` (C1 follow-up —
 *      services/webhooks/chain-payloads.ts:134-155,205-221 — both events used
 *      to carry no review id at all, which is why this module still tries
 *      every key spelling rather than assuming any one of them is present).
 *
 * So this module reads `type ?? event`, resolves the review id across all three
 * key spellings, and classifies exhaustively. An event it does not recognise is
 * classified `unknown` and is NEVER reported as a decision — the failure mode is
 * "keep waiting", never "resume with a made-up outcome".
 *
 * This file is the single source of truth for both `GatewerkRequestReview`
 * (which consumes it on resume) and `GatewerkTrigger` (which consumes it on
 * every inbound event). Keep it in step with the two API files named above.
 *
 * It deliberately imports nothing: the package must ship zero runtime
 * dependencies to stay eligible for n8n verification, so the enum values below
 * are inlined copies of `packages/shared/src/enums.ts`.
 */

/** Mirrors DECISIONS in packages/shared/src/enums.ts:4. */
export const GATEWERK_DECISIONS = [
  'approved',
  'rejected',
  'edited',
  'retried',
  'expired',
  'max_iterations_reached',
  'confirmed',
  'vetoed',
] as const;

/**
 * Coarse family an event belongs to. This is what the node's `resumeOn`
 * parameter selects over, so the names are user-facing.
 */
export type GatewerkEventClass =
  /** The review reached a final human (or auto) outcome. */
  | 'decision'
  /** The review ran out of time or iterations. */
  | 'expiry'
  /** The review bounced back for another pass — it is still open. */
  | 'iteration'
  /** The review moved to a different assignee. It is still open. */
  | 'assignment'
  /** A chain-lifecycle event for a run this review takes part in. */
  | 'chain'
  /** Not recognised. Never treated as a decision. */
  | 'unknown';

/**
 * Which output the node emits on. Index order is fixed by
 * GATEWERK_OUTPUT_ORDER and is part of the node's public contract.
 */
export type GatewerkOutcome = 'approved' | 'rejected' | 'edited' | 'expired' | 'other';

/**
 * Every value `outcome` can take. Exhaustive: 'other' is the catch-all, so an
 * event can never end up without an outcome.
 *
 * This is NOT an output-branch order. A waiting n8n execution can only ever
 * resume on output 0 (see the `outputs` comment on GatewerkRequestReview), so
 * callers branch on this value with a Switch node instead.
 */
export const GATEWERK_OUTCOMES: readonly GatewerkOutcome[] = [
  'approved',
  'rejected',
  'edited',
  'expired',
  'other',
] as const;

export interface ClassifiedGatewerkEvent {
  /** `type ?? event ?? ''`. Empty only when the body carries neither. */
  eventName: string;
  eventClass: GatewerkEventClass;
  outcome: GatewerkOutcome;
  /**
   * True when this event ends the review's (or chain run's) life, so nothing
   * further will arrive for it. Non-terminal events leave the execution waiting.
   */
  terminal: boolean;
  /**
   * `review_id ?? next_review_id ?? rejecting_review_id ?? final_review_id ??
   * anchor_review_id`, when present.
   */
  reviewId?: string;
  chainRunId?: string;
  /** Only set for events that genuinely carry an outcome. Never invented. */
  decision?: string;
  decidedAt?: string;
  wasEdited?: boolean;
  editedPayload?: Record<string, unknown>;
  approvedValue?: Record<string, unknown>;
  suggestedValue?: Record<string, unknown>;
  feedback?: string;
  reviewer?: string;
  promptEdit?: string;
  timeoutAction?: string;
  actionId?: string;
  actionLabel?: string;
  actionValue?: string;
  iterationCount?: number;
  autoApproved?: boolean;
  /** Verbatim body, always included so nothing the API sends is lost. */
  raw: Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Map a `review.decided` payload onto an output branch.
 *
 * `was_edited` wins over the raw decision: an approval that changed the payload
 * is routed to `edited` so a workflow can react to the edit rather than
 * silently shipping the reviewer's version down the "approved" path.
 */
function decidedOutcome(decision: string | undefined, wasEdited: boolean): GatewerkOutcome {
  if (wasEdited || decision === 'edited') return 'edited';
  switch (decision) {
    case 'approved':
    case 'confirmed':
      return 'approved';
    case 'rejected':
    case 'vetoed':
      return 'rejected';
    // Both mean "no human ever decided" — time ran out, or the agent burned
    // its iteration budget. They belong on the same branch.
    case 'expired':
    case 'max_iterations_reached':
      return 'expired';
    default:
      return 'other';
  }
}

/**
 * Classify one inbound Gatewerk webhook body.
 *
 * Total over the sixteen event types the API emits, and safe for anything else:
 * an unrecognised body yields `{ eventClass: 'unknown', terminal: false }`.
 */
export function classifyGatewerkEvent(payload: Record<string, unknown>): ClassifiedGatewerkEvent {
  // `type` is the documented key, but action + custom-iteration events use
  // `event`. Reading only one of them is bug #1.
  const eventName = str(payload.type) ?? str(payload.event) ?? '';

  // final_review_id (chain.completed) and anchor_review_id (chain.aborted)
  // landed after this module's initial C1 pass (chain-payloads.ts:28,87) —
  // both events used to carry no review id at all. Trying both keeps the two
  // terminal chain events, now reclassified as 'decision' below, from
  // reporting an empty reviewId when the API actually names one.
  const reviewId =
    str(payload.review_id) ??
    str(payload.next_review_id) ??
    str(payload.rejecting_review_id) ??
    str(payload.final_review_id) ??
    str(payload.anchor_review_id);

  const base: ClassifiedGatewerkEvent = {
    eventName,
    eventClass: 'unknown',
    outcome: 'other',
    terminal: false,
    reviewId,
    chainRunId: str(payload.chain_run_id),
    feedback: str(payload.feedback) ?? str(payload.rejection_feedback),
    raw: payload,
  };

  switch (eventName) {
    case 'review.decided': {
      const decision = str(payload.decision);
      const wasEdited = payload.was_edited === true;
      return {
        ...base,
        eventClass: 'decision',
        outcome: decidedOutcome(decision, wasEdited),
        terminal: true,
        decision,
        decidedAt: str(payload.decided_at),
        wasEdited,
        editedPayload: obj(payload.edited_payload),
        approvedValue: obj(payload.approved_value),
        suggestedValue: obj(payload.suggested_value),
        reviewer: str(payload.reviewer),
        promptEdit: str(payload.prompt_edit),
        actionValue: str(payload.action_value),
        actionLabel: str(payload.action_label),
        autoApproved: payload.auto_approved === true ? true : undefined,
        iterationCount:
          typeof payload.iteration_count === 'number' ? payload.iteration_count : undefined,
      };
    }

    case 'review.expired':
      return {
        ...base,
        eventClass: 'expiry',
        outcome: 'expired',
        terminal: true,
        decision: 'expired',
        decidedAt: str(payload.expired_at),
        timeoutAction: str(payload.timeout_action),
      };

    // HOTL monitoring gate: a veto blocks the action the agent already took.
    case 'review.vetoed':
      return {
        ...base,
        eventClass: 'decision',
        outcome: 'rejected',
        terminal: true,
        decision: 'vetoed',
        decidedAt: str(payload.vetoed_at),
        reviewer: str(payload.vetoed_by),
        feedback: str(payload.note) ?? base.feedback,
      };

    // The monitoring window closed without a veto — explicitly, or by lapsing.
    case 'review.confirmed':
      return {
        ...base,
        eventClass: 'decision',
        outcome: 'approved',
        terminal: true,
        decision: 'confirmed',
        decidedAt: str(payload.confirmed_at),
        reviewer: str(payload.decided_by),
      };

    // ---- Still open. The review will emit a terminal event later. ----

    case 'review.retried':
      return {
        ...base,
        eventClass: 'iteration',
        terminal: false,
        decision: 'retried',
        promptEdit: str(payload.prompt_edit),
      };

    case 'review.sent_back':
      return {
        ...base,
        eventClass: 'iteration',
        terminal: false,
        feedback: str(payload.decline_reason) ?? base.feedback,
      };

    case 'review.questions_raised':
      return {
        ...base,
        eventClass: 'iteration',
        terminal: false,
        feedback: str(payload.question_text) ?? base.feedback,
      };

    // Fires *alongside* review.decided for configurable actions. Resuming on it
    // as well would double-resume the same execution.
    case 'review.action_taken':
      return {
        ...base,
        eventClass: 'iteration',
        terminal: false,
        actionId: str(obj(payload.action)?.id),
        actionLabel: str(obj(payload.action)?.label),
        editedPayload: obj(payload.edited_payload),
        iterationCount:
          typeof payload.review_version === 'number' ? payload.review_version : undefined,
      };

    case 'assignment.escalated':
      return { ...base, eventClass: 'assignment', terminal: false };

    // ---- Chain lifecycle ----

    // Intermediate progress: the run is still going, another step (or the
    // same step retried) will follow. Must never classify as 'decision' —
    // a chain resumes the workflow when the CHAIN finishes, never when a
    // step does.
    case 'chain.next_step_ready':
    case 'chain.step_rejected':
    case 'chain.step_halted':
      return { ...base, eventClass: 'chain', terminal: false };

    // C1: one step of a route decided (buildChainStepDecidedPayload,
    // chain-payloads.ts:189-225). It deliberately carries no `total_steps` /
    // `is_final` because finality isn't knowable at the point it fires, so this
    // module must not infer it either. Same non-resuming shape as the other
    // intermediate chain events above — a chain resumes the workflow when the
    // CHAIN finishes, never when a step does.
    case 'chain.step_decided':
      return { ...base, eventClass: 'chain', terminal: false };

    // ---- Terminal chain outcomes: the CHAIN finished, not just a step. ----
    // These are the only chain events classified 'decision', which is what
    // lets the shipped default `resumeOn: ['decision', 'expiry']` wake a
    // chain-attached waiting execution at all. The API stopped sending
    // review.decided for chain-attached reviews (step 1's approval was
    // shape-identical to final authorization, and an agent keying on it would
    // act before the last approver looked) — without this reclassification
    // nothing here ever resolves to 'decision' or 'expiry' for a chain, and the
    // execution hangs until its wait timeout.
    // `final_decision` rather than a hardcoded 'approved'. Under the
    // `continue` rejection policy a route reaches completeRun with a REJECTED
    // final step, so chain.completed can fire over a refusal. The API added
    // that field precisely so this side does not have to guess; hardcoding
    // here would have thrown the guard away on arrival.
    case 'chain.completed': {
      const finalDecision = str(payload.final_decision) ?? 'approved';
      const rejectedFinalStep = finalDecision === 'rejected';
      return {
        ...base,
        eventClass: 'decision',
        outcome: rejectedFinalStep ? 'rejected' : 'approved',
        terminal: true,
        decision: finalDecision,
      };
    }

    case 'chain.rejected':
      return {
        ...base,
        eventClass: 'decision',
        outcome: 'rejected',
        terminal: true,
        decision: 'rejected',
      };

    case 'chain.aborted':
      return {
        ...base,
        eventClass: 'decision',
        outcome: 'other',
        terminal: true,
        decision: 'aborted',
      };

    default:
      break;
  }

  // Operator-authored iteration events carry an arbitrary `event` name plus
  // `action_id` (services/reviews/actions.ts:332-344). They are iterations, not
  // decisions — the review stays open.
  if (str(payload.action_id) !== undefined && str(payload.type) === undefined) {
    return {
      ...base,
      eventClass: 'iteration',
      terminal: false,
      actionId: str(payload.action_id),
    };
  }

  // Genuinely unrecognised. Deliberately NOT a decision.
  return base;
}

/**
 * Flatten a classified event into the node's output JSON.
 *
 * `decision` is present only when the event actually carried an outcome, so a
 * downstream `$json.decision === 'approved'` test can never be fooled by an
 * event that never decided anything.
 */
export function toOutputJson(event: ClassifiedGatewerkEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    event: event.eventName,
    eventClass: event.eventClass,
    outcome: event.outcome,
    terminal: event.terminal,
  };

  if (event.reviewId) out.reviewId = event.reviewId;
  if (event.chainRunId) out.chainRunId = event.chainRunId;
  if (event.decision) out.decision = event.decision;
  if (event.decidedAt) out.decidedAt = event.decidedAt;
  if (event.wasEdited !== undefined) out.wasEdited = event.wasEdited;
  if (event.editedPayload) out.editedPayload = event.editedPayload;
  if (event.approvedValue) out.approvedValue = event.approvedValue;
  if (event.suggestedValue) out.suggestedValue = event.suggestedValue;
  if (event.feedback) out.feedback = event.feedback;
  if (event.reviewer) out.reviewer = event.reviewer;
  if (event.promptEdit) out.promptEdit = event.promptEdit;
  if (event.timeoutAction) out.timeoutAction = event.timeoutAction;
  if (event.actionId) out.actionId = event.actionId;
  if (event.actionLabel) out.actionLabel = event.actionLabel;
  if (event.actionValue) out.actionValue = event.actionValue;
  if (event.iterationCount !== undefined) out.iterationCount = event.iterationCount;
  if (event.autoApproved !== undefined) out.autoApproved = event.autoApproved;

  out.rawPayload = event.raw;
  return out;
}

// Pure-function action dispatcher for the configurable-actions primitive.
// Phase 2 of v1.4 configurable-actions (spec §3.1, §5, §7, §9, §14 Phase 2).
//
// invokeAction takes a review snapshot, an action id, an actor, and optional
// feedback / edited payload, then computes a state update + audit payload +
// webhook list. No DB writes, no HTTP, no side effects — the route handler
// performs persistence and webhook dispatch.
//
// Result-pattern (not throw-pattern) is deliberate for a side-effect-free
// function: validation outcomes are values, not exceptions. The route handler
// translates `{ ok: false, code }` into the appropriate ConflictError /
// InvalidRequestError to keep wire-level error semantics matching the rest of
// the API.

import { isIterationStatus } from "@gatewerk/shared";
import type {
  TemplateActionConfig,
  ActionKind,
  DecisionValue,
  TriggerPath,
  ReviewStatus,
} from "@gatewerk/shared";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Who performed the action. Format goes into `last_action_by` and audit
 * `actor` as `"<kind>:<id>"` (e.g. `"reviewer:idris@gatewerk.com"`,
 * `"chain:step_abc"`). The `id` field is what the caller wants surfaced — for
 * reviewers we conventionally use email (matches existing audit convention,
 * see audit.test.ts:60).
 */
export interface ActionActor {
  kind: "reviewer" | "chain" | "agent" | "external";
  id: string;
  email?: string;
  /**
   * Human-readable decider for `reviews.decided_by`, when it differs from
   * `id`. A review-link decision needs both: `id` stays the token id so
   * `last_action_by` and the audit line remain forensically unambiguous,
   * while this is the person a History screen can actually print.
   */
  display?: string;
  /**
   * Whether the name above was confirmed. A public review link confirms
   * nobody — its decider is the label the SHARER typed — so it passes false.
   * Defaults by kind: anything but `external` arrived through a login, an API
   * key or the system, so an omitted value must not silently claim
   * verification for the one kind that cannot be trusted to have it.
   */
  verified?: boolean;
}

export interface InvokeActionInput {
  review: {
    id: string;
    status: ReviewStatus;
    current_version: number;
    /** Already normalized via normalizeTemplateActions() at the route layer. */
    template_actions_snapshot: TemplateActionConfig[];
  };
  actionId: string;
  actor: ActionActor;
  triggerPath: TriggerPath;
  feedback?: string;
  editedPayload?: Record<string, unknown>;
  /** Optimistic lock — when present, must equal review.current_version. */
  expectedVersion?: number;
}

/**
 * Fields the route handler should write to the reviews row. `decision` and
 * `decided_at` / `decided_by` are touched only on decision-kind actions;
 * iteration and side_effect leave them as-is (route handler should pass
 * `undefined` for un-touched fields rather than null).
 */
export interface ReviewStateUpdate {
  status: ReviewStatus;
  decision?: "approved" | "rejected";
  decided_at?: Date;
  decided_by?: string;
  decided_by_verified?: boolean;
  last_action_id: string;
  last_action_kind: ActionKind;
  last_action_at: Date;
  last_action_by: string;
}

export interface ActionAuditPayload {
  action: "review.action_taken";
  resource_type: "review";
  resource_id: string;
  actor: string;
  details: {
    action_id: string;
    action_label: string;
    action_kind: ActionKind;
    decision_value: DecisionValue | null;
    feedback: string | null;
    edited_payload: Record<string, unknown> | null;
    version: number;
    previous_version: number;
    trigger_path: TriggerPath;
  };
}

export interface WebhookOutbound {
  event: string;
  payload: Record<string, unknown>;
}

export type ActionErrorCode =
  | "action.unknown_action"
  | "action.status_not_allowed"
  | "action.feedback_required"
  | "version_mismatch";

export type InvokeActionResult =
  | {
      ok: true;
      stateUpdate: ReviewStateUpdate;
      audit: ActionAuditPayload;
      webhooks: WebhookOutbound[];
    }
  | {
      ok: false;
      code: ActionErrorCode;
      message: string;
      field?: string;
    };

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

const LEGACY_REQUEST_CHANGES_ID = "request_changes";
// Reserved id for the cancellation preset (spec §S14). The dispatcher special-
// cases it to revert status back to 'pending' — id-based recognition (vs a
// user-authorable schema field) keeps cancel semantics internal so a crafted
// custom side_effect action cannot silently reset review state.
const CANCEL_ITERATION_ID = "cancel_iteration";

function formatActor(actor: ActionActor): string {
  return `${actor.kind}:${actor.id}`;
}

export function invokeAction(input: InvokeActionInput): InvokeActionResult {
  const { review, actionId, actor, triggerPath } = input;

  // 1. Resolve action.
  const action = review.template_actions_snapshot.find((a) => a.id === actionId);
  if (!action) {
    return {
      ok: false,
      code: "action.unknown_action",
      message: `Action '${actionId}' is not configured on this review's template`,
      field: "action_id",
    };
  }

  // 2. Status guard. Per spec §3.2, default enabled_for_status = ["pending"].
  const enabledStatuses = action.enabled_for_status ?? ["pending"];
  if (!enabledStatuses.includes(review.status)) {
    return {
      ok: false,
      code: "action.status_not_allowed",
      message: `Action '${actionId}' cannot be invoked on a review with status '${review.status}'`,
    };
  }

  // 3. Feedback guard.
  if (action.requires_feedback === true && !input.feedback?.trim()) {
    return {
      ok: false,
      code: "action.feedback_required",
      message: `Action '${actionId}' requires feedback`,
      field: "feedback",
    };
  }

  // 4. Optimistic lock.
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== review.current_version
  ) {
    return {
      ok: false,
      code: "version_mismatch",
      message: `Expected version ${input.expectedVersion} but review is at version ${review.current_version}`,
    };
  }

  // 5. Role gate — deferred per spec §12 anti-principle.

  // 6. Compute state update.
  const now = new Date();
  const formattedActor = formatActor(actor);
  const baseUpdate = {
    last_action_id: action.id,
    last_action_kind: action.kind,
    last_action_at: now,
    last_action_by: formattedActor,
  };

  let stateUpdate: ReviewStateUpdate;
  switch (action.kind) {
    case "decision": {
      // Decision actions terminate the review. decision_value is required for
      // this kind per spec §7.1; the schema enforces it but we re-check here so
      // a malformed snapshot can't slip a decision-kind action without a value
      // through to the DB.
      if (!action.decision_value) {
        return {
          ok: false,
          code: "action.unknown_action",
          message: `Action '${actionId}' is kind=decision but missing decision_value`,
          field: "action_id",
        };
      }
      stateUpdate = {
        ...baseUpdate,
        status: "decided",
        decision: action.decision_value,
        decided_at: now,
        // Legacy SDK contract: reviews.decided_by stores the raw human-
        // readable identifier (email, api-key prefix) — NOT the formatted
        // "<kind>:<id>" shape. Existing consumers compare decided_by directly
        // to their email/key. The formatted variant lives on last_action_by
        // (the v1.4-introduced column) where the kind-prefix is required for
        // unambiguous actor disambiguation.
        //
        // `display` exists because a review-link decision has two identities:
        // the token id, which is unambiguous but unreadable, and the person,
        // which is what this column is contracted to hold. Without it the
        // History screen printed `gw_tok_...` where a name belongs.
        decided_by: actor.display ?? actor.id,
        decided_by_verified: actor.verified ?? actor.kind !== "external",
      };
      break;
    }
    case "iteration": {
      // Canonical 'awaiting_iteration' (not legacy 'changes_requested') —
      // existing READ sites tolerate both via the ITERATION_STATUSES
      // centralization.
      stateUpdate = {
        ...baseUpdate,
        status: "awaiting_iteration",
      };
      break;
    }
    case "side_effect": {
      // Default side_effect: no status change, only last_action_* reflect activity.
      // Special case (spec §S14): cancel_iteration reverts an in-flight
      // iteration back to pending. Recognized by id rather than a user-
      // authorable schema field — keeps the cancel semantic internal so a
      // crafted custom side_effect action cannot silently reset review state.
      const nextStatus =
        action.id === CANCEL_ITERATION_ID && isIterationStatus(review.status)
          ? "pending"
          : review.status;
      stateUpdate = {
        ...baseUpdate,
        status: nextStatus,
      };
      break;
    }
  }

  // 7. Audit payload (spec §4.5).
  const audit: ActionAuditPayload = {
    action: "review.action_taken",
    resource_type: "review",
    resource_id: review.id,
    actor: formattedActor,
    details: {
      action_id: action.id,
      action_label: action.label,
      action_kind: action.kind,
      decision_value: action.decision_value ?? null,
      feedback: input.feedback ?? null,
      edited_payload: input.editedPayload ?? null,
      // version + previous_version are equal at action time. Iteration version
      // bumps happen on the agent's next submit (lifecycle.updateVersion), not
      // at action invocation.
      version: review.current_version,
      previous_version: review.current_version,
      trigger_path: triggerPath,
    },
  };

  // 8. Webhook events (spec §9).
  const webhooks: WebhookOutbound[] = [];

  // Always: unified review.action_taken with the full primitive payload.
  webhooks.push({
    event: "review.action_taken",
    payload: {
      event: "review.action_taken",
      review_id: review.id,
      review_version: review.current_version,
      previous_version: review.current_version,
      action: {
        id: action.id,
        label: action.label,
        kind: action.kind,
        decision_value: action.decision_value ?? null,
      },
      actor: {
        type: actor.kind,
        id: actor.id,
        ...(actor.email ? { email: actor.email } : {}),
      },
      feedback: input.feedback ?? null,
      edited_payload: input.editedPayload ?? null,
      trigger_path: triggerPath,
      timestamp: now.toISOString(),
    },
  });

  // Legacy compat dual-fire for one minor version per spec §11.2.
  if (action.kind === "decision" && action.decision_value) {
    webhooks.push({
      event: "review.decided",
      payload: {
        event: "review.decided",
        review_id: review.id,
        decision: action.decision_value,
        feedback: input.feedback ?? null,
        edited_payload: input.editedPayload ?? null,
        decided_by: formattedActor,
        decided_at: now.toISOString(),
      },
    });
  } else if (action.kind === "iteration") {
    if (action.id === LEGACY_REQUEST_CHANGES_ID) {
      // Only the legacy preset dual-fires review.retried — custom iteration
      // actions ('escalate', 'send_to_qa', etc.) had no historic precedent
      // emitting review.retried, so adding it for them would invent legacy.
      webhooks.push({
        event: "review.retried",
        payload: {
          event: "review.retried",
          review_id: review.id,
          feedback: input.feedback ?? null,
          retried_by: formattedActor,
          retried_at: now.toISOString(),
        },
      });
    } else {
      // Custom iteration actions emit either action.webhook_event or the
      // auto-derived 'review.iteration_<id>'. Spec §9.3.
      const customEvent = action.webhook_event ?? `review.iteration_${action.id}`;
      webhooks.push({
        event: customEvent,
        payload: {
          event: customEvent,
          review_id: review.id,
          action_id: action.id,
          feedback: input.feedback ?? null,
          actor: formattedActor,
          timestamp: now.toISOString(),
        },
      });
    }
  }
  // side_effect kind: no legacy compat (no historic event to dual-fire).

  return { ok: true, stateUpdate, audit, webhooks };
}

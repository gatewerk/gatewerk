// Maps the action service's webhooks list onto the existing wh.* outbound
// HTTP infrastructure. Phase 2 of v1.4 configurable-actions (spec §9 +
// §11.2 dual-fire backwards compat).
//
// Two payload-construction strategies coexist here:
//   - For 'review.action_taken' and custom iteration events, the upstream
//     action service (services/reviews/actions.ts) is the spec-authoritative
//     payload constructor; this dispatcher passes its payload through to
//     sendActionTaken / sendCustomIteration unchanged.
//   - For legacy events ('review.decided', 'review.retried'), the existing
//     wh.sendDecision / wh.sendRetry methods construct the wire payload from
//     primitive data fields per the historic legacy contract. The action
//     service's payload for these events is ignored at the outbound layer
//     (it remains useful at the internal eventBus emit surface, where a
//     spec-shape payload is appropriate).
//
// The dispatcher is a pure async-promise factory: callers decide whether to
// await all promises (Promise.all), fire-and-forget (existing decide.ts
// pattern via .catch(console.error)), or interleave with other writes.

import type { WebhookService } from "../webhooks";
import type { WebhookOutbound } from "./actions";

export interface ActionWebhookDispatchInput {
  wh: WebhookService;
  webhooks: WebhookOutbound[];
  callbackUrl: string;
  hmacSecret: string;
  reviewId: string;
  /** Required when result.webhooks contains a 'review.decided' entry. */
  decision?: string | null;
  /** Required when result.webhooks contains a 'review.decided' entry. */
  decidedAt?: Date | null;
  /** Optional reviewer label for legacy review.decided payload (mirrors decide.ts). */
  decidedBy?: string | null;
  /** Computed approved_value for legacy review.decided payload. */
  approvedValue?: Record<string, unknown> | null;
  /** Computed suggested_value for legacy review.decided payload. */
  suggestedValue?: Record<string, unknown> | null;
  /** Edited payload for both legacy review.decided and review.retried. */
  editedPayload?: Record<string, unknown> | null;
  /** Feedback text shared across review.decided / review.retried legacy payloads. */
  feedback?: string | null;
  /** Action id used as fallback for legacy action_value field. */
  actionId?: string;
  /** Action label used as fallback for legacy action_label field. */
  actionLabel?: string;
  /** Request id propagated for X-Request-Id correlation. */
  requestId?: string;
  /**
   * The chain run the review belongs to, or null. Threaded through so
   * sendDecision can withhold the frozen review.decided payload for a chain
   * step, whose approval is otherwise shape-identical to final authorization
   * (C1 charter §5.1).
   */
  chainRunId: string | null;
  /**
   * The resolved action's kind. Decision-kind events are the ones that can be
   * mistaken for authorization; iteration and side-effect events are not.
   */
  actionKind?: string | null;
  /**
   * Iteration count for the frozen decision-callback contract (Task 2).
   * Equals current_version - 1 at the point the action resolved. Passed
   * through to wh.sendDecision as iteration_count. Omit when undefined
   * (JSON.stringify drops undefined values).
   */
  iterationCount?: number;
}

export function dispatchActionWebhooks(
  input: ActionWebhookDispatchInput,
): Promise<void>[] {
  const promises: Promise<void>[] = [];

  for (const ev of input.webhooks) {
    if (ev.event === "review.action_taken") {
      promises.push(
        input.wh.sendActionTaken({
          callback_url: input.callbackUrl,
          hmac_secret: input.hmacSecret,
          review_id: input.reviewId,
          payload: ev.payload,
          chain_run_id: input.chainRunId,
          action_kind: input.actionKind ?? null,
          request_id: input.requestId,
        }),
      );
      continue;
    }

    if (ev.event === "review.decided") {
      // Legacy review.decided wire contract (mirrors decide.ts:103-119).
      // Constructs the payload here rather than passing ev.payload through
      // because subscribers parse the legacy 'type' field shape.
      promises.push(
        input.wh.sendDecision({
          callback_url: input.callbackUrl,
          hmac_secret: input.hmacSecret,
          review_id: input.reviewId,
          chain_run_id: input.chainRunId,
          decision: input.decision ?? "",
          decided_at: input.decidedAt ? input.decidedAt.toISOString() : "",
          suggested_value: input.suggestedValue ?? undefined,
          approved_value: input.approvedValue ?? undefined,
          edited_payload: input.editedPayload ?? undefined,
          was_edited: !!input.editedPayload,
          feedback: input.feedback ?? undefined,
          reviewer: input.decidedBy ?? undefined,
          action_value: input.actionId,
          action_label: input.actionLabel,
          iteration_count: input.iterationCount,
          request_id: input.requestId,
        }),
      );
      continue;
    }

    if (ev.event === "review.retried") {
      // Legacy review.retried wire contract (mirrors decide.ts:202-209).
      promises.push(
        input.wh.sendRetry({
          callback_url: input.callbackUrl,
          hmac_secret: input.hmacSecret,
          review_id: input.reviewId,
          feedback: input.feedback ?? undefined,
          request_id: input.requestId,
        }),
      );
      continue;
    }

    // Custom iteration event (review.iteration_<id> auto-derived, or a
    // user-set action.webhook_event). Spec §9.3: pass the upstream-built
    // payload through directly.
    promises.push(
      input.wh.sendCustomIteration({
        callback_url: input.callbackUrl,
        hmac_secret: input.hmacSecret,
        review_id: input.reviewId,
        event_name: ev.event,
        payload: ev.payload,
        request_id: input.requestId,
      }),
    );
  }

  return promises;
}

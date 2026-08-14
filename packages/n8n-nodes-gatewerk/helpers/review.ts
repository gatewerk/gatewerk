import type { GatewerkEventClass } from './events';

/**
 * Body builder and resume policy for review creation.
 *
 * Lives in helpers rather than on the node so the consolidated `Gatewerk` node
 * and its tests can share one definition of the wire contract.
 */

export interface BuildReviewBodyInput {
  template: string;
  payload: Record<string, unknown>;
  callbackUrl?: string;
  priority?: string;
  actions?: string[];
  confidence?: number;
  irreversibility?: string;
  assignee?: string;
  metadata?: Record<string, unknown>;
  timeoutAction?: string;
  timeoutSeconds?: number;
  oversight?: string;
  assignmentLadder?: unknown[];
  idempotencyKey?: string;
  traceUrl?: string;
  maxIterations?: number;
}

/**
 * Build the POST /api/v1/reviews body.
 *
 * Field names are the API's snake_case wire names, validated against
 * ReviewCreateBodySchema (packages/shared/src/api/schemas/reviews.ts:288-353).
 * Optional fields are OMITTED rather than sent as null, because the server
 * distinguishes "absent" from "explicitly null" for several of them: an absent
 * `priority` falls back to the template's `default_priority`, while a value
 * always wins.
 */
export function buildReviewBody(input: BuildReviewBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    template: input.template,
    payload: input.payload,
  };

  if (input.callbackUrl) body.callback_url = input.callbackUrl;
  if (input.priority) body.priority = input.priority;
  if (input.actions && input.actions.length > 0) body.actions = input.actions;
  if (input.confidence !== undefined && input.confidence !== null)
    body.confidence = input.confidence;
  if (input.irreversibility) body.irreversibility = input.irreversibility;
  if (input.assignee) body.assignee = input.assignee;
  if (input.metadata && Object.keys(input.metadata).length > 0) body.metadata = input.metadata;

  // `oversight: "monitoring"` is mutually exclusive with a timeout action and
  // with an assignment ladder (services/reviews/monitoring-gate.ts:21-84). Send
  // what the user asked for and let the API return its specific 400 rather than
  // second-guessing the rules here, which would drift from the server.
  if (input.oversight) body.oversight = input.oversight;
  if (input.assignmentLadder && input.assignmentLadder.length > 0)
    body.assignment_ladder = input.assignmentLadder;
  if (input.idempotencyKey) body.idempotency_key = input.idempotencyKey;
  if (input.traceUrl) body.trace_url = input.traceUrl;
  if (input.maxIterations !== undefined && input.maxIterations !== null)
    body.max_iterations = input.maxIterations;

  if (input.timeoutAction) {
    body.timeout = {
      action: input.timeoutAction,
      seconds: input.timeoutSeconds || 3600,
    };
  }

  return body;
}

/**
 * Decide whether an inbound event should resume a waiting execution.
 *
 * Exported so the decision table is testable without standing up an n8n
 * webhook context.
 */
export function shouldResumeOn(eventClass: GatewerkEventClass, resumeOn: string[]): boolean {
  // 'unknown' is never resumable. An event we do not understand must never be
  // allowed to look like a decision.
  if (eventClass === 'unknown') return false;
  const selected = resumeOn.length > 0 ? resumeOn : ['decision', 'expiry'];
  return selected.includes(eventClass);
}

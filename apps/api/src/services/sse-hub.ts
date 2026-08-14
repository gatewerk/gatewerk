import { NOTIFICATION_EVENTS, type NotificationEvent } from "@gatewerk/shared";
import type { EventBus, EventData } from "./events";

type Listener = (event: NotificationEvent, data: EventData) => void;

export interface Subscription {
  close(): void;
}

// Per-user connection counts, keyed by (authType:identity).
// apikey → `apikey:{projectId}:{apiKeyId}`
// session → `session:{reviewerId}`
type CounterKey = string;
const connectionCounts = new Map<CounterKey, number>();

export function currentConnectionCount(key: CounterKey): number {
  return connectionCounts.get(key) ?? 0;
}

export function acquireConnectionSlot(key: CounterKey, max: number): boolean {
  const current = connectionCounts.get(key) ?? 0;
  if (current >= max) return false;
  connectionCounts.set(key, current + 1);
  return true;
}

function releaseConnectionSlot(key: CounterKey): void {
  const current = connectionCounts.get(key) ?? 0;
  if (current <= 1) {
    connectionCounts.delete(key);
  } else {
    connectionCounts.set(key, current - 1);
  }
}

// Test helper: reset global connection state between test runs.
export function __resetConnectionCountsForTest(): void {
  connectionCounts.clear();
}

/**
 * Subscribe a single listener to every NOTIFICATION_EVENT on the bus and
 * return a subscription whose `close()` detaches every handler cleanly
 * and releases the per-user connection slot.
 *
 * Uses `EventBus.on()`'s returned unsubscribe function so SSE disconnects
 * don't leak handlers across long-running server lifetimes. No reflection
 * into bus internals — the bus exposes exactly the surface we need.
 */
export function subscribeAll(
  bus: EventBus,
  counterKey: CounterKey,
  listener: Listener,
): Subscription {
  const unsubscribers: Array<() => void> = [];

  for (const event of NOTIFICATION_EVENTS) {
    const handler = (data: EventData) => listener(event, data);
    unsubscribers.push(bus.on(event, handler));
  }

  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      for (const unsub of unsubscribers) unsub();
      releaseConnectionSlot(counterKey);
    },
  };
}

/**
 * Serialize an EventBus event into the SSE wire shape.
 *
 * Base fields (review_id / project_id / template_slug / priority / created_at)
 * are always emitted. Event-specific enriched fields (decision, expired_at,
 * escalated_at, etc.) are forwarded when the emit site populated them on
 * `EventData`. Dashboard consumers branch on `type` to read the fields
 * relevant to each event, so undefined fields are dropped from the wire
 * payload rather than serialized as `null`.
 */
export interface SseWirePayload {
  type: NotificationEvent;
  review_id: string;
  project_id: string;
  template_slug: string;
  priority: string;
  created_at: string;
  // Per-event enriched fields — all optional, present only when populated.
  decision?: string;
  decided_at?: string;
  expired_at?: string;
  timeout_action?: string;
  previous_assignee?: string | null;
  new_assignee?: string | null;
  ladder_index?: number;
  escalated_at?: string;
  // Chain context. Present only when
  // the underlying review is chain-attached. Non-chain emits drop these
  // fields from the wire so cloud bandwidth + logging stay unchanged.
  chain_run_id?: string;
  chain_step_id?: string;
  step_index?: number;
  total_steps?: number;
  // External send-back fields (Plan 6 C1). Present only for
  // review.sent_back / review.questions_raised events.
  decline_reason?: string | null;
  question_text?: string;
  // HOTL monitoring gate. Veto note, present only
  // for review.vetoed events. Deliberately NOT decline_reason — that field
  // belongs to the send-back flow above.
  note?: string | null;
  // Monitoring-gate window deadline, forwarded from EventData so countdown
  // consumers (routes/reviews/crud.ts ~line 361) can render without a refetch.
  expires_at?: string;
}

export function toWirePayload(event: NotificationEvent, data: EventData): SseWirePayload {
  const payload: SseWirePayload = {
    type: event,
    review_id: data.review_id,
    project_id: data.project_id,
    template_slug: data.template,
    priority: data.priority,
    created_at: data.created_at,
  };
  // Include enriched fields only when populated — drops `undefined`
  // rather than serializing explicit nulls on the wire.
  if (data.decision !== undefined) payload.decision = data.decision;
  if (data.decided_at !== undefined) payload.decided_at = data.decided_at;
  if (data.expired_at !== undefined) payload.expired_at = data.expired_at;
  if (data.timeout_action !== undefined) payload.timeout_action = data.timeout_action;
  if (data.previous_assignee !== undefined) payload.previous_assignee = data.previous_assignee;
  if (data.new_assignee !== undefined) payload.new_assignee = data.new_assignee;
  if (data.ladder_index !== undefined) payload.ladder_index = data.ladder_index;
  if (data.escalated_at !== undefined) payload.escalated_at = data.escalated_at;
  if (data.chain_run_id !== undefined) payload.chain_run_id = data.chain_run_id;
  if (data.chain_step_id !== undefined) payload.chain_step_id = data.chain_step_id;
  if (data.step_index !== undefined) payload.step_index = data.step_index;
  if (data.total_steps !== undefined) payload.total_steps = data.total_steps;
  if (data.decline_reason !== undefined) payload.decline_reason = data.decline_reason;
  if (data.question_text !== undefined) payload.question_text = data.question_text;
  if (data.note !== undefined) payload.note = data.note;
  if (data.expires_at !== undefined) payload.expires_at = data.expires_at;
  return payload;
}

import type { Decision, NotificationEvent, Priority } from "@gatewerk/shared";

export interface EventData {
  review_id: string;
  template: string;
  project_id: string;
  priority: Priority;
  created_at: string;
  // Event-specific enriched fields. Populated by the emitting site when the
  // event type carries richer state; notification webhook adapters ignore
  // fields they do not render, SSE serializers pick the fields relevant to
  // each event type off of this shape.
  decision?: Decision;
  decided_at?: string;
  expired_at?: string;
  // HOTL monitoring gate: veto-window end, populated by the
  // review.monitoring_created emit so consumers can render the countdown
  // without a refetch. Distinct from expired_at (past tense, review.expired
  // only).
  expires_at?: string;
  timeout_action?: string;
  previous_assignee?: string | null;
  new_assignee?: string | null;
  ladder_index?: number;
  escalated_at?: string;
  // Chain context. Populated by emit sites whose review is chain-attached
  // (review.chain_run_id != null). Non-chain reviews leave these unset;
  // toWirePayload drops undefined fields so non-chain wire payloads stay
  // byte-identical when no chain fields are present.
  chain_run_id?: string;
  chain_step_id?: string;
  step_index?: number;     // 1-based step position
  total_steps?: number;
  // External send-back fields (Plan 6 C1). Populated by the decline /
  // raise-questions emit sites; absent for all other event types.
  decline_reason?: string | null;
  question_text?: string;
  // HOTL monitoring gate. Populated by the review.veto_delivery_failed
  // emit site only; absent for all other events.
  delivery_id?: string;
  failed_at?: string;
  // HOTL monitoring gate terminal outcomes.
  // review.vetoed: vetoed_at + vetoed_by + note; review.confirmed:
  // confirmed_at + decided_by + lapsed. Absent for all other event types.
  // note is DISTINCT from decline_reason — that field's semantic owner is
  // the external-recipient send-back flow; the veto note must not ride it.
  vetoed_at?: string;
  vetoed_by?: string;
  note?: string | null;
  confirmed_at?: string;
  decided_by?: string;
  lapsed?: boolean;
  /**
   * Overrides who gets tapped, instead of resolving from the review's assignee.
   * Used by chain events, where the person to notify is the chain's owner and
   * not whoever happened to decide its final step.
   */
  notify_assignee?: string;
}

type EventHandler = (data: EventData) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<NotificationEvent, EventHandler[]>();

  /**
   * Register a handler for an event. Returns an unsubscribe function;
   * calling it detaches exactly this handler (no-op if already detached).
   * Prefer the returned unsubscribe over `off()` for lexically-scoped
   * registrations — it avoids having to hold a reference to the handler.
   */
  on(event: NotificationEvent, handler: EventHandler): () => void {
    const existing = this.handlers.get(event) || [];
    existing.push(handler);
    this.handlers.set(event, existing);
    return () => this.off(event, handler);
  }

  /**
   * Explicitly detach a handler. Idempotent — detaching a handler that
   * isn't registered is a no-op. Useful when the registration site and
   * the teardown site aren't lexically adjacent (e.g. long-running
   * servers that register on connect, detach on disconnect).
   */
  off(event: NotificationEvent, handler: EventHandler): void {
    const list = this.handlers.get(event);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) this.handlers.delete(event);
  }

  emit(event: NotificationEvent, data: EventData): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;

    // Copy before iterating so a handler that calls `off()` during emit
    // (e.g. a one-shot subscriber) doesn't mutate the array we're walking.
    for (const handler of [...handlers]) {
      try {
        const result = handler(data);
        // If handler returns a promise, catch errors silently
        if (result && typeof result.catch === "function") {
          result.catch((err) => {
            console.error("EventBus handler error", { event, err });
          });
        }
      } catch (err) {
        console.error("EventBus handler error", { event, err });
      }
    }
  }
}

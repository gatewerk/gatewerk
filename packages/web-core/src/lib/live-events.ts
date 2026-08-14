// Pure helpers for the live-feed dashboard wiring. Kept separate from the
// React hooks so they can be unit-tested without a DOM (vitest default env
// has no `document` / `EventSource` / `localStorage`).

export type LiveEventType =
  | "review.created"
  | "review.urgent"
  | "review.assigned"
  | "review.decided"
  | "review.expired"
  | "review.retried"
  | "review.assignment_escalated"
  | "review.action_taken"
  | "review.sent_back"
  | "review.questions_raised"
  // HOTL monitoring gate (spec §4.9 + NOTIFICATION_EVENTS in @gatewerk/shared).
  | "review.monitoring_created"
  | "review.vetoed"
  | "review.confirmed"
  | "review.veto_delivery_failed"
  | "review.confirmed_delivery_failed";

export interface ReviewLiveEvent {
  type: LiveEventType;
  review_id: string;
  project_id: string;
  template_slug: string;
  priority: string;
  created_at: string;
  // Chain context. Present only when
  // the underlying review is chain-attached. Used by the dashboard
  // handleLiveEvent dispatcher to invalidate the per-review chain panel
  // queryKey instead of polling every 30s for chain transitions.
  chain_run_id?: string;
  chain_step_id?: string;
  step_index?: number;
  total_steps?: number;
}

export interface OpenFrame {
  type: "open";
}

export type LiveEvent = ReviewLiveEvent | OpenFrame;

const MAX_BACKOFF_MS = 30_000;
const MAX_EXPONENT = 5; // 2^5 = 32s before clamping to max.

/** Exponential backoff with a 1s floor and 30s ceiling. */
export function backoffMs(attempt: number, max = MAX_BACKOFF_MS): number {
  const exponent = Math.min(Math.max(0, attempt), MAX_EXPONENT);
  const base = 1000 * 2 ** exponent;
  return Math.min(base, max);
}

/** Stable cross-tab identifier for a live event — used for toast dedup. */
export function eventKey(event: LiveEvent): string {
  if (event.type === "open") return "open";
  return `${event.review_id}:${event.type}:${event.created_at}`;
}

/** Tab title with a count prefix. 99+ above 99 to keep the title short. */
export function formatTabTitle(base: string, pendingCount: number): string {
  if (pendingCount <= 0) return base;
  const label = pendingCount > 99 ? "99+" : String(pendingCount);
  return `(${label}) ${base}`;
}

// Minimal Storage surface — localStorage satisfies this natively, test fakes
// only need two methods.
export interface DedupStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Cross-tab dedup: first tab to write the key wins the toast; others see
 * the timestamp within `ttlMs` and skip. Fail-open on storage errors so
 * Safari private-browsing / disabled storage doesn't silently drop
 * notifications.
 */
export function shouldShowToast(
  eventId: string,
  storage: DedupStorage,
  now: number = Date.now(),
  ttlMs = 5000,
): boolean {
  const key = `gw_toast:${eventId}`;
  try {
    const prev = storage.getItem(key);
    if (prev) {
      const prevTs = parseInt(prev, 10);
      if (!Number.isNaN(prevTs) && now - prevTs < ttlMs) return false;
    }
    storage.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

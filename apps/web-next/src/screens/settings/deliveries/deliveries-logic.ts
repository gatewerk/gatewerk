/**
 * deliveries-logic.ts — pure helpers for the Deliveries (webhook delivery
 * log) pane. Same split as activity-logic.ts: web-next has no render
 * harness, so branching/formatting logic lives here and is unit-tested; the
 * pane component is a thin shell over these functions.
 *
 * Behavior ported from apps/web's pages/settings/project/deliveries/
 * DeliveriesPane.tsx (the reference this was rebuilt from) — offset
 * pagination against `has_more`, the status vocabulary, and the retry
 * eligibility rule all carry over. The reference's `status !== "delivered"`
 * retry gate is NOT carried over: only "failed" deliveries here offer Retry.
 * A "pending" delivery is already queued for its next attempt (see
 * `next_attempt_at`); a manual retry on it would race the scheduler rather
 * than recover anything, so the affordance is withheld until a delivery has
 * actually given up.
 */
import type { ListDeliveriesParams, WebhookDelivery } from "@gatewerk/web-core/api/deliveries";
import { endOfDayIso, startOfDayIso } from "@gatewerk/web-core/lib/filter-dates";

export const DELIVERIES_PAGE_SIZE = 50;

/** Error text longer than this truncates behind a Show/Hide disclosure. */
export const DELIVERY_ERROR_TRUNCATE = 100;

/**
 * Merge one fetched page into the running list. Offset 0 is a fresh load and
 * replaces; any later offset is a "Load more" page and appends. Same
 * contract as activity-logic.ts's appendActivityPage.
 */
export function appendDeliveriesPage(
  prev: WebhookDelivery[],
  page: WebhookDelivery[],
  offset: number,
): WebhookDelivery[] {
  return offset === 0 ? page : [...prev, ...page];
}

/**
 * Status pill tone. `null` means delivered — the default, quiet state that
 * renders no pill at all (defaults render as silence). Failed and pending
 * are the only two states that earn live-attention color.
 */
export function deliveryStatusTone(status: string): "failed" | "pending" | null {
  if (status === "failed") return "failed";
  if (status === "pending") return "pending";
  return null;
}

/** Only a failed delivery can be retried — see the file doc for why. */
export function canRetryDelivery(status: string): boolean {
  return status === "failed";
}

export type DeliveryStatusFilter = "all" | "pending" | "failed" | "delivered";

/**
 * "all" is the unfiltered default and omits the query param entirely
 * (matching the endpoint's own optional `status` filter, which already
 * exists server-side — webhook-deliveries.ts:43-45 — this pane just never
 * exposed it until now).
 */
export function deliveryStatusParam(filter: DeliveryStatusFilter): string | undefined {
  return filter === "all" ? undefined : filter;
}

/**
 * The webhook_deliveries.event_type vocabulary this project's own review
 * lifecycle actually writes (grepped from services/webhooks.ts's `deliver`
 * call sites) — deliberately NOT the same list as webhooks/webhooks-logic.ts's
 * AVAILABLE_EVENTS. That list is the newer named-webhook (notification_channels)
 * event vocabulary, a different system from this legacy per-project delivery
 * log (see DeliveriesPane's file doc), and the two don't match: AVAILABLE_EVENTS
 * has review.created/urgent/assigned, none of which this table ever writes, and
 * is missing review.veto_delivery_failed/review.confirmed_delivery_failed, which
 * it does.
 *
 * Not exhaustive: custom iteration actions can fire a dynamic event_type
 * (`review.iteration_<id>` or a template-supplied name — services/webhooks.ts's
 * sendCustomIteration doc comment, "no CHECK constraint on that column"). Those
 * stay unfiltered by this list, same tradeoff Activity's own Action filter
 * already accepts for its fixed-but-large AUDIT_ACTIONS vocabulary.
 */
export const DELIVERY_EVENT_TYPES: Array<{ value: string; label: string }> = [
  { value: "review.decided", label: "Review decided" },
  { value: "review.retried", label: "Review retried" },
  { value: "review.action_taken", label: "Action taken" },
  { value: "review.expired", label: "Review expired" },
  { value: "review.sent_back", label: "Review sent back" },
  { value: "review.questions_raised", label: "Questions raised" },
  { value: "review.vetoed", label: "Review vetoed" },
  { value: "review.confirmed", label: "Review confirmed" },
  { value: "review.veto_delivery_failed", label: "Veto delivery failed" },
  { value: "review.confirmed_delivery_failed", label: "Confirm delivery failed" },
];

export interface DeliveryFilters {
  status: DeliveryStatusFilter;
  eventType: string[];
  /** Bare `YYYY-MM-DD` from the date inputs, or "" for unset — same
   *  shape-stays-input-shaped convention as ActivityFilters. */
  dateFrom: string;
  dateTo: string;
}

export const EMPTY_DELIVERY_FILTERS: DeliveryFilters = {
  status: "all",
  eventType: [],
  dateFrom: "",
  dateTo: "",
};

/** GET /api/v1/webhooks/deliveries params for one page — the from/to date
 *  range needed a real backend addition (the route had no date filtering at
 *  all); status already existed server-side; event_type is the same shape
 *  the route just gained (repeated `event_type=` params, inArray server-side). */
export function buildDeliveryParams(filters: DeliveryFilters, offset: number): ListDeliveriesParams {
  const status = deliveryStatusParam(filters.status);
  return {
    ...(status && { status }),
    ...(filters.eventType.length > 0 && { event_type: filters.eventType }),
    ...(filters.dateFrom && { from: startOfDayIso(filters.dateFrom) }),
    ...(filters.dateTo && { to: endOfDayIso(filters.dateTo) }),
    limit: DELIVERIES_PAGE_SIZE,
    offset,
  };
}

export function hasActiveDeliveryFilters(filters: DeliveryFilters): boolean {
  return (
    filters.status !== "all" || filters.eventType.length > 0 || filters.dateFrom !== "" || filters.dateTo !== ""
  );
}

/**
 * Whether event type or date range is set — status is deliberately left out.
 * The status control is SegmentedTabs: it always shows a selection and "All"
 * is itself a one-click reset, so a non-"all" status needs no separate Clear
 * affordance. Event type and date range both have a genuine unset state
 * ("All events" / "Any time") that isn't one click away from the bar itself
 * (you'd have to open the dropdown/popover and clear it from inside) — that's
 * what the outer Clear link is for. Used for the Clear link's visibility
 * only; `hasActiveDeliveryFilters` (status included) still drives the "No
 * matching deliveries" vs "No deliveries yet" empty-state message, where
 * status correctly does matter.
 */
export function hasActiveDismissableDeliveryFilters(
  filters: Pick<DeliveryFilters, "eventType" | "dateFrom" | "dateTo">,
): boolean {
  return filters.eventType.length > 0 || filters.dateFrom !== "" || filters.dateTo !== "";
}

/**
 * The mono meta line alongside the event chip: attempt count only. The URL
 * gets its own line (manifest S7.1's url line is separate from the
 * event/attempt/time line), and the relative time is appended by the caller
 * (needs `Date.now()`, kept out of this pure module), same split as
 * ActivityPane's `activityEventMeta`.
 */
export function deliveryMeta(delivery: Pick<WebhookDelivery, "attempts" | "max_attempts">): string[] {
  return [`attempt ${delivery.attempts}/${delivery.max_attempts}`];
}

/**
 * Which timestamp a row's relative-time reads from: the last attempt if one
 * was made, else when the delivery was created (a delivery still waiting on
 * its first attempt has no last_attempt_at yet). Matches the reference's
 * `last_attempt_at ?? created_at` fallback.
 */
export function deliveryTimestamp(delivery: Pick<WebhookDelivery, "last_attempt_at" | "created_at">): string {
  return delivery.last_attempt_at ?? delivery.created_at;
}

/** Whether `error` needs the Show/Hide disclosure rather than rendering flat. */
export function isDeliveryErrorLong(error: string): boolean {
  return error.length > DELIVERY_ERROR_TRUNCATE;
}

/** Truncated error text with an ellipsis, for the collapsed disclosure state. */
export function truncateDeliveryError(error: string): string {
  return `${error.slice(0, DELIVERY_ERROR_TRUNCATE)}…`;
}

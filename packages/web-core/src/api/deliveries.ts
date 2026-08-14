import { request } from "./client/http";

export interface WebhookDelivery {
  id: string;
  object: string;
  review_id: string;
  event_type: string;
  url: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface DeliveryListPage {
  object: "list";
  items: WebhookDelivery[];
  total: number;
  has_more: boolean;
}

/**
 * Fetch webhook deliveries for a specific review.
 * Scoped to review_id; the API project-gates results server-side.
 */
export async function getDeliveriesForReview(reviewId: string): Promise<DeliveryListPage> {
  return request<DeliveryListPage>(
    `/api/v1/webhooks/deliveries?review_id=${encodeURIComponent(reviewId)}&limit=50`,
  );
}

export interface ListDeliveriesParams {
  limit?: number;
  offset?: number;
  status?: string;
  /** Sent as repeated `event_type=` query params, same convention as
   *  ListAuditParams's `action` — the route's Express side already parses
   *  repeated keys into an array. */
  event_type?: string | string[];
  /** ISO instants, not bare dates — see ListAuditParams's same note. */
  from?: string;
  to?: string;
}

/**
 * Fetch the project-wide delivery log, newest first, offset-paginated.
 * The endpoint already served this mode (apps/web called it with a raw fetch);
 * this wrapper exists so web-next's Deliveries pane goes through the typed
 * layer like every other pane.
 */
export async function listDeliveries(
  params: ListDeliveriesParams = {},
): Promise<DeliveryListPage> {
  const qs = new URLSearchParams({
    limit: String(params.limit ?? 50),
    offset: String(params.offset ?? 0),
  });
  if (params.status) qs.set("status", params.status);
  if (params.event_type) {
    const eventTypes = Array.isArray(params.event_type) ? params.event_type : [params.event_type];
    for (const e of eventTypes) qs.append("event_type", e);
  }
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  return request<DeliveryListPage>(`/api/v1/webhooks/deliveries?${qs.toString()}`);
}

/** Queue a failed delivery for immediate re-attempt. */
export async function retryDelivery(deliveryId: string): Promise<unknown> {
  return request<unknown>(`/api/v1/webhooks/deliveries/${encodeURIComponent(deliveryId)}/retry`, {
    method: "POST",
  });
}

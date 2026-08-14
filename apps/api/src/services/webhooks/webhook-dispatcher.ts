/**
 * WebhookEvent — the canonical input shape for dispatching a webhook.
 * Callers construct this from domain types; the dispatcher owns delivery
 * mechanics and signing.
 */
export interface WebhookEvent {
  /** Stable delivery ID. Must be preserved across retries for receiver dedup. */
  deliveryId: string;
  /** Event type string, e.g. "review.decided", "chain.completed". */
  eventType: string;
  /** Destination URL. Must be HTTPS in production. */
  url: string;
  /** Pre-serialised payload object. Dispatcher JSON.stringifies before signing. */
  payload: Record<string, unknown>;
  /** Project HMAC secret. Used for both legacy and Standard Webhooks signing. */
  hmacSecret: string;
  /** Correlating request ID (omitted for background retries). */
  requestId?: string;
  /** Review ID — required for webhook_deliveries FK (NOT NULL on review_id column). */
  reviewId: string;
}

/**
 * DispatchId — opaque string returned after a dispatch is accepted.
 * For the pg-boss impl this is the delivery row ID.
 * For the Hookdeck impl this is the Hookdeck event ID.
 */
export type DispatchId = string;

/**
 * DeliveryStatus — polled via verifyDeliveryStatus().
 */
export type DeliveryStatus =
  | { state: "pending" }
  | { state: "delivered"; deliveredAt: Date }
  | { state: "failed"; lastError: string; attempts: number }
  | { state: "unknown" };

/**
 * Signature — all three signing formats emitted simultaneously.
 *
 * v1  — legacy `sha256=<hex>`: HMAC-SHA256(body, secret)
 * v2  — replay-safe `t=<unix-seconds>,v1=<hex>`: HMAC-SHA256(`${t}.${body}`, secret)
 * swh — Standard Webhooks header value per https://www.standardwebhooks.com
 *       Format: `v1,<base64>` where base64 = base64(HMAC-SHA256(`${msgId}\n${ts}\n${body}`, secret))
 */
export interface Signature {
  v1: string;
  v2: string;
  /** Standard Webhooks `webhook-signature` value (single key). */
  swh: string;
  /** Unix seconds timestamp used for v2 and swh. */
  timestamp: number;
}

/**
 * WebhookDispatcher — delivery abstraction.
 *
 * Implementations:
 *   OSS:   PgBossWebhookDispatcher (wraps existing WebhookService + retry worker)
 *   Cloud: HookdeckWebhookDispatcher (Hookdeck REST API)
 *
 * Both implementations share the contract test suite in
 * `__tests__/webhook-dispatcher-contract.ts`.
 */
export interface WebhookDispatcher {
  /**
   * Enqueue a webhook delivery. Returns a DispatchId that can be used to
   * poll status. Implementations are responsible for retry, backoff, and
   * HMAC signing per the Standard Webhooks spec.
   */
  dispatch(event: WebhookEvent): Promise<DispatchId>;

  /**
   * Poll delivery status. Returns `{ state: "unknown" }` when the ID is not found.
   *
   * MAY REJECT with Error when the underlying provider returns an auth error
   * (401/403) or a server error (5xx). Callers polling cloud-adapter status
   * must handle Promise rejection. OSS adapters (pg-boss) never reject.
   */
  verifyDeliveryStatus(id: DispatchId): Promise<DeliveryStatus>;

  /**
   * Compute all three signature formats for a given payload + secret.
   * Exposed so the settings UI can render a "verify example" without
   * dispatching a real event.
   *
   * `payload` is serialised to JSON by this method.
   * `timestamp` defaults to `Math.floor(Date.now() / 1000)` when omitted.
   */
  signPayload(
    payload: unknown,
    secret: string,
    timestamp?: number,
  ): Signature;
}

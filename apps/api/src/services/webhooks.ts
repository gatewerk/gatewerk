import { eq } from "drizzle-orm";
import { hmacSha256 } from "../lib/crypto";
import { webhookDeliveries, reviews } from "@gatewerk/db/src/schema/index";
import { generateId, VERSION } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import { config } from "../config";
import { buildSwhHeaders, type StandardWebhookHeaders } from "./webhooks/standard-webhooks";
import type { EventBus } from "./events";
import {
  buildChainNextStepReadyPayload,
  buildChainCompletedPayload,
  buildChainStepDecidedPayload,
  buildChainRejectedPayload,
  buildChainStepRejectedPayload,
  buildChainStepHaltedPayload,
  buildChainAbortedPayload,
  type SendChainNextStepReadyData,
  type SendChainCompletedData,
  type SendChainStepDecidedData,
  type SendChainRejectedData,
  type SendChainStepRejectedData,
  type SendChainStepHaltedData,
  type SendChainAbortedData,
} from "./webhooks/chain-payloads";
import { suppressesReviewDecided, suppressesActionTaken } from "./webhooks/chain-suppression";
// Re-export chain data types so call sites (chain-engine.ts, etc.) can import
// them from the same path they use for WebhookService without a deep import.
export type {
  SendChainNextStepReadyData,
  SendChainCompletedData,
  SendChainRejectedData,
  SendChainStepRejectedData,
  SendChainStepHaltedData,
  SendChainAbortedData,
} from "./webhooks/chain-payloads";

const BACKOFF_SECONDS = [1, 5, 30, 120, 600]; // 1s, 5s, 30s, 2min, 10min

const USER_AGENT = `Gatewerk/${VERSION}`;

export interface WebhookOpts {
  fetch?: typeof globalThis.fetch;
  /** When omitted, deliveries skip persistence (fire-and-forget mode). */
  db?: AppDb;
  /** Optional. When present, terminal delivery failures emit lifecycle alerts:
   *  review.veto_delivery_failed (a lost veto is DANGEROUS: the action stands
   *  and the agent never undoes) and review.confirmed_delivery_failed (a lost
   *  confirm leaves the agent unable to distinguish confirmed from webhook
   *  lost). */
  eventBus?: EventBus;
}

export class WebhookService {
  private fetchFn: typeof globalThis.fetch;
  private db: AppDb | undefined;
  private eventBus: EventBus | undefined;

  constructor(opts?: WebhookOpts) {
    this.fetchFn = opts?.fetch || globalThis.fetch;
    this.db = opts?.db;
    this.eventBus = opts?.eventBus;
  }

  /**
   * Compute legacy v1, replay-safe v2, and Standard Webhooks (swh) signatures.
   *
   *   v1 = `sha256=<hex>` where hex = HMAC-SHA256(body, secret)
   *        — unchanged since v1.0; the public GA contract. Exists for
   *          receivers that don't care about replay protection.
   *   v2 = `t=<unix-seconds>,v1=<hex>` where hex = HMAC-SHA256(ts.body, secret)
   *        — Stripe-style envelope. Receivers verify by:
   *            1. Parsing `t` and `v1`.
   *            2. Checking `abs(now - t) < tolerance` (e.g., 300s).
   *            3. Recomputing HMAC(`${t}.${body}`, secret) and constant-time
   *               comparing to `v1`.
   *          A replay attacker can't forge a timestamp without the secret,
   *          so stale deliveries fail the freshness gate.
   *
   * All three formats are emitted on every delivery (separate headers) —
   * additive, no breaking change. Receivers can migrate at their own pace.
   * swhHeaders follows https://www.standardwebhooks.com (webhook-id,
   * webhook-timestamp, webhook-signature).
   */
  private sign(
    deliveryId: string,
    body: string,
    secret: string,
  ): { v1: string; v2: string; timestamp: number; swhHeaders: StandardWebhookHeaders } {
    const timestamp = Math.floor(Date.now() / 1000);
    const v1Hex = hmacSha256(secret, body);
    const v2Hex = hmacSha256(secret, `${timestamp}.${body}`);
    const swhHeaders = buildSwhHeaders(deliveryId, body, secret, timestamp);
    return {
      v1: `sha256=${v1Hex}`,
      v2: `t=${timestamp},v1=${v2Hex}`,
      timestamp,
      swhHeaders,
    };
  }

  private truncatePayload(payload: Record<string, unknown>): string {
    let body = JSON.stringify(payload);
    if (body.length > 1024 * 1024) {
      const truncated = {
        ...payload,
        edited_payload: null,
        truncated: true,
        review_url: `${config.uiOrigin}/reviews/${payload.review_id}`,
        message: "Payload truncated. Use review_url to fetch full data via API.",
      };
      body = JSON.stringify(truncated);
    }
    return body;
  }

  private async deliver(
    deliveryId: string,
    url: string,
    payload: Record<string, unknown>,
    hmacSecret: string,
    eventType: string,
    requestId?: string,
  ): Promise<void> {
    const body = this.truncatePayload(payload);
    const signatures = this.sign(deliveryId, body, hmacSecret);

    const controller = new AbortController();
    const connectionTimeout = setTimeout(() => controller.abort(), 10_000);

    // Deliberate header shape, mirrors GitHub/Stripe *receivers* for minimal friction:
    //   User-Agent        — identifies us; versioned so receivers can gate on us.
    //   X-Webhook-Event   — event type (review.decided / review.retried / review.expired).
    //   X-Webhook-Id      — UUID stable across retries of the same event; receivers
    //                       use it as the idempotency key.
    //   X-Webhook-Signature    — v1 legacy: `sha256=<hex>` of the raw body.
    //                            Receivers recompute HMAC(body, secret) and
    //                            constant-time compare. Does not prevent replay.
    //   X-Webhook-Signature-V2 — v2 replay-safe: `t=<unix-seconds>,v1=<hex>` where
    //                            hex = HMAC(`${t}.${body}`, secret). Receivers who
    //                            care about replay parse `t`, enforce freshness,
    //                            then verify the hex. Both are emitted on every
    //                            delivery; additive, non-breaking.
    //   webhook-id / webhook-timestamp / webhook-signature
    //                      — Standard Webhooks spec (https://www.standardwebhooks.com).
    //                        Emitted additively; receivers can adopt at their own pace.
    //   X-Request-Id      — correlation ID from the originating HTTP request.
    //                       Omitted on timeout-worker / retry-worker deliveries
    //                       (no originating request).
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "X-Webhook-Event": eventType,
      "X-Webhook-Id": deliveryId,
      // Legacy v1 + v2 — kept for backwards compatibility
      "X-Webhook-Signature": signatures.v1,
      "X-Webhook-Signature-V2": signatures.v2,
      // Standard Webhooks spec — https://www.standardwebhooks.com
      // Emitted additively; receivers can adopt at their own pace.
      ...signatures.swhHeaders,
    };
    if (requestId) headers["X-Request-Id"] = requestId;

    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(connectionTimeout);

      // Read response body with a separate timeout (30s)
      const bodyTimeout = setTimeout(() => controller.abort(), 30_000);
      const responseText = await res.text().catch(() => "");
      clearTimeout(bodyTimeout);

      if (res.ok) {
        if (this.db) {
          await this.db.update(webhookDeliveries)
            .set({
              status: "delivered",
              delivered_at: new Date(),
              last_attempt_at: new Date(),
            })
            .where(eq(webhookDeliveries.id, deliveryId));
        }
      } else {
        const errorMsg = `HTTP ${res.status}: ${responseText.slice(0, 1024)}`;
        await this.handleFailure(deliveryId, errorMsg);
      }
    } catch (err: any) {
      clearTimeout(connectionTimeout);
      const errorMsg = err.name === "AbortError" ? "Connection timeout" : (err.message || "Unknown error");
      await this.handleFailure(deliveryId, errorMsg);
      console.error("Webhook delivery failed", { url, error: errorMsg });
    }
  }

  private async handleFailure(deliveryId: string, error: string): Promise<void> {
    if (!this.db) return;

    const [delivery] = await this.db.select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);

    if (!delivery) return;

    const attempts = delivery.attempts;
    if (attempts >= delivery.max_attempts) {
      await this.db.update(webhookDeliveries)
        .set({
          status: "failed",
          last_error: error,
          last_attempt_at: new Date(),
        })
        .where(eq(webhookDeliveries.id, deliveryId));

      // review.vetoed and review.confirmed are first-class terminal-failure
      // alerts: a lost veto means
      // the agent never undid the action; a lost confirm means the agent can't
      // distinguish "confirmed" from "webhook lost". Surface both the same way.
      if (delivery.event_type === "review.vetoed" && this.eventBus) {
        await this.emitTerminalDeliveryFailure(delivery, "review.veto_delivery_failed");
      } else if (delivery.event_type === "review.confirmed" && this.eventBus) {
        await this.emitTerminalDeliveryFailure(delivery, "review.confirmed_delivery_failed");
      }
    } else {
      const backoffIndex = Math.min(attempts - 1, BACKOFF_SECONDS.length - 1);
      const base = BACKOFF_SECONDS[backoffIndex] * 1000;
      const jitter = Math.random() * base * 0.3; // +0-30% jitter to prevent retry storms
      const backoffMs = base + jitter;
      const nextAttempt = new Date(Date.now() + backoffMs);

      await this.db.update(webhookDeliveries)
        .set({
          status: "pending",
          last_error: error,
          last_attempt_at: new Date(),
          next_attempt_at: nextAttempt,
        })
        .where(eq(webhookDeliveries.id, deliveryId));
    }
  }

  /**
   * Isolated try/catch: a transient DB error on the review context SELECT must
   * not escape handleFailure — deliver's catch would re-invoke handleFailure
   * with the DB error as last_error (corrupting the row) or swallow the
   * original delivery error entirely.
   */
  private async emitTerminalDeliveryFailure(
    delivery: typeof webhookDeliveries.$inferSelect,
    eventName: "review.veto_delivery_failed" | "review.confirmed_delivery_failed",
  ): Promise<void> {
    try {
      const failedAt = new Date().toISOString();
      const [review] = await this.db!.select({
        project_id: reviews.project_id,
        template_slug: reviews.template_slug,
        priority: reviews.priority,
        created_at: reviews.created_at,
      }).from(reviews).where(eq(reviews.id, delivery.review_id)).limit(1);

      if (!review) {
        console.error("terminal-delivery-failure: review row missing; alert will reach no notification channels", {
          event: eventName,
          delivery_id: delivery.id,
          review_id: delivery.review_id,
        });
      }

      this.eventBus!.emit(eventName, {
        review_id: delivery.review_id,
        delivery_id: delivery.id,
        failed_at: failedAt,
        project_id: review?.project_id ?? "",
        template: review?.template_slug ?? "",
        priority: (review?.priority as any) ?? "normal",
        created_at: review?.created_at?.toISOString() ?? failedAt,
      });
    } catch (emitErr) {
      console.error("terminal-delivery-failure: failed to emit event", {
        event: eventName,
        delivery_id: delivery.id,
        review_id: delivery.review_id,
        err: emitErr,
      });
    }
  }

  private async createDelivery(
    reviewId: string,
    eventType: string,
    url: string,
    payload: Record<string, unknown>,
    /**
     * Write the row already terminal, for a delivery that is recorded but
     * deliberately not sent (C1 chain suppression). Must be set at INSERT
     * rather than patched afterwards: the default row carries status='pending'
     * with next_attempt_at = now, which is exactly what WebhookRetryWorker
     * claims, so an update-after-insert leaves a window in which the retry
     * sweep would POST the payload the suppression exists to withhold.
     */
    suppressed = false,
  ): Promise<string> {
    const id = generateId("delivery");

    if (this.db) {
      await this.db.insert(webhookDeliveries).values({
        id, review_id: reviewId, event_type: eventType, url, payload,
        status: suppressed ? "suppressed" : "pending",
        attempts: suppressed ? 0 : 1,
        next_attempt_at: suppressed ? null : new Date(),
      });
    }

    return id;
  }

  /**
   * Retry a specific delivery (called by WebhookRetryWorker). The delivery id
   * (which we ship back out as X-Webhook-Id) is intentionally stable across
   * attempts so receivers can dedupe.
   */
  async retryDelivery(delivery: {
    id: string;
    url: string;
    payload: Record<string, unknown>;
    hmac_secret: string;
    event_type: string;
    attempts: number;
    max_attempts: number;
  }): Promise<void> {
    if (this.db) {
      await this.db.update(webhookDeliveries)
        .set({ attempts: delivery.attempts + 1 })
        .where(eq(webhookDeliveries.id, delivery.id));
    }

    await this.deliver(delivery.id, delivery.url, delivery.payload, delivery.hmac_secret, delivery.event_type);
  }

  /**
   * Fire the decision callback to the agent's callback_url.
   *
   * FROZEN PAYLOAD CONTRACT (v1 — do NOT extend without a versioning plan):
   *   {
   *     type: "review.decided",
   *     review_id: string,
   *     decision: string,        // enum value — UNCHANGED, do not extend
   *     decided_at: string,      // ISO-8601
   *     was_edited: boolean,
   *     iteration_count: number, // ALWAYS present: integer >= 0 equal to
   *                              // current_version - 1 (0 when the review was
   *                              // decided on its first version).
   *     feedback?: string,
   *     edited_payload?: Record<string, unknown>,
   *     suggested_value?: Record<string, unknown>,
   *     approved_value?: Record<string, unknown>,
   *     reviewer?: string,
   *     prompt_edit?: string,
   *     action_value?: string,
   *     action_label?: string,
   *     auto_approved?: true,
   *   }
   *
   * The `decision` enum values (approved, rejected, edited, retried, expired,
   * max_iterations_reached) are FROZEN for v1. `max_iterations_reached` is a
   * system-generated terminal decision emitted by TimeoutWorker when a review
   * exceeds its max_iterations cap — receivers should treat it as a final
   * rejection signal. Adding new values is a breaking change for receivers that
   * switch on this field. Any extension requires a new contract version
   * negotiated at the API level.
   *
   * NOT SENT FOR CHAIN-ATTACHED REVIEWS (C1, charter §5.1). See
   * webhooks/chain-suppression.ts for why silence rather than an added field.
   *
   * `chain_run_id` is REQUIRED, not optional, so every call site — the action
   * dispatcher, the auto-approve create path, and both TimeoutWorker paths —
   * has to answer the question at compile time rather than inherit a default.
   * The delivery row is still written, with status='suppressed', so the
   * operator's delivery log shows what was withheld and why.
   */
  async sendDecision(data: {
    callback_url: string;
    hmac_secret: string;
    review_id: string;
    decision: string;
    decided_at: string;
    suggested_value?: Record<string, unknown>;
    approved_value?: Record<string, unknown>;
    edited_payload?: Record<string, unknown>;
    was_edited?: boolean;
    feedback?: string;
    reviewer?: string;
    prompt_edit?: string;
    action_value?: string;
    action_label?: string;
    auto_approved?: boolean;
    /**
     * Number of revision rounds: current_version - 1 (0 on first version).
     * Real callers ALWAYS pass a number per the frozen contract; the optional
     * type + conditional-include below is a safe mechanism for direct callers.
     */
    iteration_count?: number;
    request_id?: string;
    /**
     * The chain run this review belongs to, or null when it belongs to none.
     * REQUIRED — see the contract note above. Non-null suppresses dispatch.
     */
    chain_run_id: string | null;
  }) {
    const payload: Record<string, unknown> = {
      type: "review.decided",
      review_id: data.review_id,
      decision: data.decision,
      decided_at: data.decided_at,
      was_edited: data.was_edited ?? false,
    };

    if (data.suggested_value) payload.suggested_value = data.suggested_value;
    if (data.approved_value) payload.approved_value = data.approved_value;
    if (data.edited_payload) payload.edited_payload = data.edited_payload;
    if (data.feedback) payload.feedback = data.feedback;
    if (data.reviewer) payload.reviewer = data.reviewer;
    if (data.prompt_edit) payload.prompt_edit = data.prompt_edit;
    if (data.action_value) payload.action_value = data.action_value;
    if (data.action_label) payload.action_label = data.action_label;
    if (data.auto_approved) payload.auto_approved = true;
    if (data.iteration_count !== undefined) payload.iteration_count = data.iteration_count;

    if (suppressesReviewDecided(data.chain_run_id)) {
      await this.createDelivery(data.review_id, "review.decided", data.callback_url, payload, true);
      return;
    }

    const deliveryId = await this.createDelivery(
      data.review_id, "review.decided", data.callback_url, payload,
    );
    await this.deliver(deliveryId, data.callback_url, payload, data.hmac_secret, "review.decided", data.request_id);
  }

  async sendRetry(data: {
    callback_url: string;
    hmac_secret: string;
    review_id: string;
    feedback?: string;
    prompt_edit?: string;
    request_id?: string;
  }) {
    const payload: Record<string, unknown> = {
      type: "review.retried",
      review_id: data.review_id,
      action: "retry",
    };

    if (data.feedback) payload.feedback = data.feedback;
    if (data.prompt_edit) payload.prompt_edit = data.prompt_edit;

    const deliveryId = await this.createDelivery(
      data.review_id, "review.retried", data.callback_url, payload,
    );

    await this.deliver(deliveryId, data.callback_url, payload, data.hmac_secret, "review.retried", data.request_id);
  }

  /**
   * Configurable-actions primitive (spec §9.1). Canonical event for every
   * action invocation — fires alongside legacy review.decided / review.retried
   * during the v1.4 → v1.5 transition.
   *
   * Asymmetric API vs sendDecision / sendRetry: this method accepts a
   * pre-built payload because the action service (services/reviews/actions.ts)
   * is the spec-authoritative source for the §9.1 wire shape. Constructing
   * the payload here would duplicate logic and split the source of truth.
   * The internal eventBus emit consumes the same payload, so a single
   * upstream construction guarantees parity between SSE and outbound HTTP.
   */
  async sendActionTaken(data: {
    callback_url: string;
    hmac_secret: string;
    review_id: string;
    payload: Record<string, unknown>;
    /** REQUIRED. See webhooks/chain-suppression.ts. */
    chain_run_id: string | null;
    /** The resolved action's kind, so only decisions are withheld. */
    action_kind: string | null;
    request_id?: string;
  }) {
    if (suppressesActionTaken(data.chain_run_id, data.action_kind)) {
      await this.createDelivery(data.review_id, "review.action_taken", data.callback_url, data.payload, true);
      return;
    }

    const deliveryId = await this.createDelivery(
      data.review_id,
      "review.action_taken",
      data.callback_url,
      data.payload,
    );
    await this.deliver(
      deliveryId,
      data.callback_url,
      data.payload,
      data.hmac_secret,
      "review.action_taken",
      data.request_id,
    );
  }


  /**
   * General-purpose adapter delivery primitive. Caller supplies event_type and
   * a fully-built payload; this method handles persistence + delivery.
   *
   * Differs from sendActionTaken:
   *   - event_type is caller-supplied, not hardcoded to "review.action_taken"
   *   - throws when !this.db (programmer error — no fail-soft persistence)
   *   - returns { deliveryId } so callers can use the minted ID as a DispatchId
   *
   * Used by PgBossWebhookDispatcher.dispatch() as its primary delivery path.
   */
  async sendCustom(opts: {
    event_type: string;
    callback_url: string;
    hmac_secret: string;
    review_id: string;
    payload: Record<string, unknown>;
    request_id?: string;
  }): Promise<{ deliveryId: string }> {
    const EVENT_TYPE_PATTERN = /^[a-z0-9._]{1,64}$/i;
    if (!EVENT_TYPE_PATTERN.test(opts.event_type)) {
      throw new Error(
        `WebhookService.sendCustom: invalid event_type ${JSON.stringify(opts.event_type)}; must match ${EVENT_TYPE_PATTERN}`,
      );
    }
    if (!this.db) {
      throw new Error("WebhookService.sendCustom: db required (no fail-soft persistence)");
    }
    const deliveryId = await this.createDelivery(
      opts.review_id,
      opts.event_type,
      opts.callback_url,
      opts.payload,
    );
    await this.deliver(
      deliveryId,
      opts.callback_url,
      opts.payload,
      opts.hmac_secret,
      opts.event_type,
      opts.request_id,
    );
    return { deliveryId };
  }

  /**
   * Custom iteration outbound delivery (spec §9.3). Iteration actions other
   * than the legacy 'request_changes' preset fire either action.webhook_event
   * (when set on the action config) or the auto-derived 'review.iteration_<id>'.
   * Same delivery pipeline as sendActionTaken — pre-built payload from the
   * action service. event_name is dynamic and stored as-is in
   * webhook_deliveries.event_type (no CHECK constraint on that column).
   */
  async sendCustomIteration(data: {
    callback_url: string;
    hmac_secret: string;
    review_id: string;
    event_name: string;
    payload: Record<string, unknown>;
    request_id?: string;
  }) {
    const deliveryId = await this.createDelivery(
      data.review_id,
      data.event_name,
      data.callback_url,
      data.payload,
    );
    await this.deliver(
      deliveryId,
      data.callback_url,
      data.payload,
      data.hmac_secret,
      data.event_name,
      data.request_id,
    );
  }

  async sendExpiry(data: {
    callback_url: string;
    hmac_secret: string;
    review_id: string;
    timeout_action: string;
    expired_at: string;
    request_id?: string;
  }) {
    const payload: Record<string, unknown> = {
      type: "review.expired",
      review_id: data.review_id,
      timeout_action: data.timeout_action,
      expired_at: data.expired_at,
    };

    const deliveryId = await this.createDelivery(
      data.review_id, "review.expired", data.callback_url, payload,
    );

    await this.deliver(deliveryId, data.callback_url, payload, data.hmac_secret, "review.expired", data.request_id);
  }

  /**
   * Ladder-promotion escalation (M9 Phase 1). Fired by TimeoutWorker when an
   * assignment ladder step's `trigger_after_seconds` elapses without a
   * decision. Uses the same HMAC + retry surface as decision/expiry; the
   * only shape differences are the `type` discriminator and the payload
   * fields callers need to route the review to the next actor.
   *
   * Callers must gate on `callback_url` existing before invoking this — the
   * signature mirrors `sendExpiry` and does not accept null.
   */
  /**
   * Chain engine webhook surface. Four events cover the chain lifecycle
   * that review-level webhooks can't express:
   *
   *   chain.next_step_ready — predecessor approved, step N+1 materialized
   *   chain.completed       — final step approved
   *   chain.rejected        — chain terminated (rejection_policy=terminate)
   *   chain.step_rejected   — per-step rejection policy applied (M13);
   *                           carries applied_policy + next_step_index
   *
   * The chain.restarted event was a v1 (M10) scaffold superseded by per-step
   * rejection policies in v2 (M13); its emitter was dead code (no engine call
   * site, no consumer) and was removed.
   *
   * Every chain webhook anchors to a "triggering" review_id in webhook_deliveries
   * (FK NOT NULL in schema). For chain.next_step_ready that's the freshly
   * materialized review; for chain.completed / chain.rejected it's the final
   * decided review; for chain.step_rejected it's the rejecting review.
   * This keeps the delivery log queryable by review while surfacing chain
   * context in the payload.
   */
  async sendChainNextStepReady(data: SendChainNextStepReadyData) {
    const payload = buildChainNextStepReadyPayload(data);
    const deliveryId = await this.createDelivery(
      data.next_review_id, "chain.next_step_ready", data.callback_url, payload,
    );
    await this.deliver(
      deliveryId, data.callback_url, payload, data.hmac_secret, "chain.next_step_ready", data.request_id,
    );
  }

  /**
   * C1: the chain's own per-step decision event. See
   * buildChainStepDecidedPayload for why it claims no finality and why it
   * fires from the dispatch path rather than the engine. Anchored in
   * webhook_deliveries to the review that actually decided, so
   * GET /webhooks/deliveries?review_id=<that review> finds it.
   */
  async sendChainStepDecided(data: SendChainStepDecidedData) {
    const payload = buildChainStepDecidedPayload(data);
    const deliveryId = await this.createDelivery(
      data.review_id, "chain.step_decided", data.callback_url, payload,
    );
    await this.deliver(
      deliveryId, data.callback_url, payload, data.hmac_secret, "chain.step_decided", data.request_id,
    );
  }

  async sendChainCompleted(data: SendChainCompletedData) {
    const payload = buildChainCompletedPayload(data);
    const deliveryId = await this.createDelivery(
      data.final_review_id, "chain.completed", data.callback_url, payload,
    );
    await this.deliver(
      deliveryId, data.callback_url, payload, data.hmac_secret, "chain.completed", data.request_id,
    );
  }

  async sendChainRejected(data: SendChainRejectedData) {
    const payload = buildChainRejectedPayload(data);
    const deliveryId = await this.createDelivery(
      data.rejecting_review_id, "chain.rejected", data.callback_url, payload,
    );
    await this.deliver(
      deliveryId, data.callback_url, payload, data.hmac_secret, "chain.rejected", data.request_id,
    );
  }

  /**
   * Per-step rejection notification (M13). Always fires on step rejection
   * regardless of the applied policy; `next_step_index` tells the receiver
   * what happens next:
   *
   *   abort    → next_step_index: null (chain terminated; chain.rejected fires too)
   *   continue → next_step_index: N+1 (advanced to next step; chain stays active)
   *   branch   → next_step_index: rejection_branch_to (retrying from an earlier step)
   *
   * step_index is the 1-based step_number of the rejected step. Anchored in
   * webhook_deliveries to the rejected review so receivers can correlate.
   */
  async sendChainStepRejected(data: SendChainStepRejectedData) {
    const payload = buildChainStepRejectedPayload(data);
    const deliveryId = await this.createDelivery(
      data.rejecting_review_id, "chain.step_rejected", data.callback_url, payload,
    );
    await this.deliver(
      deliveryId, data.callback_url, payload, data.hmac_secret, "chain.step_rejected", data.request_id,
    );
  }

  /**
   * Step-halted event: a chain step could not advance due to an error
   * (e.g. template deleted mid-chain, auth-tier invariant violation).
   * Anchored to `review_id` in webhook_deliveries (FK NOT NULL).
   */
  async sendChainStepHalted(data: SendChainStepHaltedData) {
    const payload = buildChainStepHaltedPayload(data);
    const deliveryId = await this.createDelivery(
      data.review_id, "chain.step_halted", data.callback_url, payload,
    );
    await this.deliver(
      deliveryId, data.callback_url, payload, data.hmac_secret, "chain.step_halted", data.request_id,
    );
  }

  /**
   * Operator-abort chain event (Task 2). Fires when POST /chain-runs/:id/abort
   * force-stops an active run. Anchored to `anchor_review_id` in
   * webhook_deliveries (the first materialized step's review, since there is no
   * callback_url on chain_runs itself).
   */
  async sendChainAborted(data: SendChainAbortedData) {
    const payload = buildChainAbortedPayload(data);
    const deliveryId = await this.createDelivery(
      data.anchor_review_id, "chain.aborted", data.callback_url, payload,
    );
    await this.deliver(
      deliveryId, data.callback_url, payload, data.hmac_secret, "chain.aborted", data.request_id,
    );
  }

  /**
   * External send-back (Plan 6 C1). Fired when a recipient declines via
   * /r/:token/decline. The review reverts to `pending` — this is NOT a
   * decision; type is "review.sent_back" (never "review.decided").
   */
  async sendSentBack(data: {
    callback_url: string;
    hmac_secret: string;
    review_id: string;
    recipient_label: string;
    decline_reason?: string | null;
    reverted_at: string;
    request_id?: string;
  }) {
    const payload: Record<string, unknown> = {
      type: "review.sent_back",
      review_id: data.review_id,
      recipient_label: data.recipient_label,
      reverted_at: data.reverted_at,
    };
    if (data.decline_reason) payload.decline_reason = data.decline_reason;
    const id = await this.createDelivery(
      data.review_id, "review.sent_back", data.callback_url, payload,
    );
    await this.deliver(id, data.callback_url, payload, data.hmac_secret, "review.sent_back", data.request_id);
  }

  /**
   * External questions-raised (Plan 6 C1). Fired when a recipient sends
   * questions via /r/:token/raise-questions. The review reverts to `pending`.
   * type is "review.questions_raised" (never "review.decided").
   */
  async sendQuestionsRaised(data: {
    callback_url: string;
    hmac_secret: string;
    review_id: string;
    recipient_label: string;
    question_text: string;
    reverted_at: string;
    request_id?: string;
  }) {
    const payload: Record<string, unknown> = {
      type: "review.questions_raised",
      review_id: data.review_id,
      recipient_label: data.recipient_label,
      question_text: data.question_text,
      reverted_at: data.reverted_at,
    };
    const id = await this.createDelivery(
      data.review_id, "review.questions_raised", data.callback_url, payload,
    );
    await this.deliver(id, data.callback_url, payload, data.hmac_secret, "review.questions_raised", data.request_id);
  }

  /**
   * HOTL monitoring gate. Human veto on an
   * already-executed action. NEW event type with its own FROZEN payload
   * contract — never "review.decided" (that contract's decision enum is
   * frozen; see sendDecision). The agent owns the undo (notify-only).
   *
   * FROZEN PAYLOAD: { type: "review.vetoed", review_id, vetoed_at,
   * vetoed_by, note? }
   */
  async sendVetoed(data: {
    callback_url: string;
    hmac_secret: string;
    review_id: string;
    vetoed_at: string;
    vetoed_by: string;
    note?: string | null;
    request_id?: string;
  }) {
    const payload: Record<string, unknown> = {
      type: "review.vetoed",
      review_id: data.review_id,
      vetoed_at: data.vetoed_at,
      vetoed_by: data.vetoed_by,
    };
    if (data.note) payload.note = data.note;
    const id = await this.createDelivery(
      data.review_id, "review.vetoed", data.callback_url, payload,
    );
    await this.deliver(id, data.callback_url, payload, data.hmac_secret, "review.vetoed", data.request_id);
  }

  /**
   * HOTL monitoring gate. Window closed with no veto.
   * NEW event type — never "review.decided". `lapsed` is MANDATORY and
   * distinguishes an unattended window lapse (true, decided_by =
   * 'system:monitoring_window') from a human Confirm-now (false, decided_by
   * = the reviewer). Informational-only: no action is expected of the agent.
   *
   * FROZEN PAYLOAD: { type: "review.confirmed", review_id, confirmed_at,
   * decided_by, lapsed }
   */
  async sendConfirmed(data: {
    callback_url: string;
    hmac_secret: string;
    review_id: string;
    confirmed_at: string;
    decided_by: string;
    lapsed: boolean;
    request_id?: string;
  }) {
    const payload: Record<string, unknown> = {
      type: "review.confirmed",
      review_id: data.review_id,
      confirmed_at: data.confirmed_at,
      decided_by: data.decided_by,
      lapsed: data.lapsed,
    };
    const id = await this.createDelivery(
      data.review_id, "review.confirmed", data.callback_url, payload,
    );
    await this.deliver(id, data.callback_url, payload, data.hmac_secret, "review.confirmed", data.request_id);
  }

  async sendAssignmentEscalated(data: {
    callback_url: string;
    hmac_secret: string;
    review_id: string;
    previous_assignee: string;
    new_assignee: string;
    ladder_index: number;
    escalated_at: string;
    metadata?: Record<string, unknown>;
    request_id?: string;
  }) {
    const payload: Record<string, unknown> = {
      type: "assignment.escalated",
      review_id: data.review_id,
      previous_assignee: data.previous_assignee,
      new_assignee: data.new_assignee,
      ladder_index: data.ladder_index,
      escalated_at: data.escalated_at,
    };
    if (data.metadata) payload.metadata = data.metadata;

    const deliveryId = await this.createDelivery(
      data.review_id,
      "assignment.escalated",
      data.callback_url,
      payload,
    );

    await this.deliver(
      deliveryId,
      data.callback_url,
      payload,
      data.hmac_secret,
      "assignment.escalated",
      data.request_id,
    );
  }
}

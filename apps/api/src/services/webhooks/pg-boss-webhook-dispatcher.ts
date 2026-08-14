import { eq } from "drizzle-orm";
import { webhookDeliveries } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import { assertNever } from "@gatewerk/shared";
import { hmacSha256 } from "../../lib/crypto";
import { buildSwhHeaders } from "./standard-webhooks";
import type {
  WebhookDispatcher,
  WebhookEvent,
  DispatchId,
  DeliveryStatus,
  Signature,
} from "./webhook-dispatcher";
import type { WebhookService } from "../webhooks";

/**
 * OSS WebhookDispatcher — thin adapter over the existing WebhookService.
 *
 * `dispatch()` delegates to `WebhookService.sendCustom` which writes to
 * `webhook_deliveries` and runs delivery synchronously with backoff via
 * `WebhookRetryWorker`. The minted delivery row ID is returned as the
 * DispatchId (NOT the caller-supplied event.deliveryId).
 *
 * Backoff curve: the existing WebhookService curve is [1s, 5s, 30s, 2m, 10m].
 * The Svix-aligned curve [15s, 5m, 30m, 2h, 5h, 10h, 24h] would require
 * migrating max_attempts and updating in-flight delivery rows.
 */
export class PgBossWebhookDispatcher implements WebhookDispatcher {
  private webhookService: WebhookService;
  private db: AppDb | undefined;

  constructor(webhookService: WebhookService, db?: AppDb) {
    this.webhookService = webhookService;
    this.db = db;
  }

  async dispatch(event: WebhookEvent): Promise<DispatchId> {
    if (!event.reviewId) {
      throw new Error(
        "PgBossWebhookDispatcher.dispatch: reviewId is required (NOT NULL FK on webhook_deliveries.review_id)",
      );
    }
    const { deliveryId } = await this.webhookService.sendCustom({
      event_type: event.eventType,
      callback_url: event.url,
      hmac_secret: event.hmacSecret,
      review_id: event.reviewId,
      payload: event.payload,
      request_id: event.requestId,
    });
    return deliveryId;
  }

  async verifyDeliveryStatus(id: DispatchId): Promise<DeliveryStatus> {
    if (!this.db) return { state: "unknown" };

    const [row] = await this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id))
      .limit(1);

    if (!row) return { state: "unknown" };

    // status is "pending" | "delivered" | "failed" per packages/db/src/schema/webhook-deliveries.ts
    const status = row.status as "pending" | "delivered" | "failed";
    switch (status) {
      case "delivered":
        return { state: "delivered", deliveredAt: row.delivered_at ?? new Date() };
      case "failed":
        return {
          state: "failed",
          lastError: row.last_error ?? "unknown",
          attempts: row.attempts,
        };
      case "pending":
        return { state: "pending" };
      default:
        return assertNever(status);
    }
  }

  /**
   * Preview-only. The `swh` signature uses the synthetic webhook-id
   * `"sign-payload-preview"` and will NOT match signatures on real deliveries
   * (which use the per-delivery `deliveryId` as webhook-id). Intended for the
   * settings UI "verify example" preview, not for receiver-side verification.
   */
  signPayload(payload: unknown, secret: string, timestamp?: number): Signature {
    const body = JSON.stringify(payload);
    const ts = timestamp ?? Math.floor(Date.now() / 1000);

    const v1Hex = hmacSha256(secret, body);
    const v2Hex = hmacSha256(secret, `${ts}.${body}`);

    // signPayload is a settings-UI preview path; no real delivery ID exists.
    // Use a stable synthetic id so the preview is reproducible.
    const swhHeaders = buildSwhHeaders("sign-payload-preview", body, secret, ts);

    return {
      v1: `sha256=${v1Hex}`,
      v2: `t=${ts},v1=${v2Hex}`,
      swh: swhHeaders["webhook-signature"],
      timestamp: ts,
    };
  }
}

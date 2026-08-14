import { eq, and } from "drizzle-orm";
import { notificationChannels } from "@gatewerk/db/src/schema/index";
import type { NotificationEvent, NotificationPayload, NotificationChannelType } from "@gatewerk/shared";
import type { EventBus, EventData } from "./events";
import { NOTIFICATION_EVENTS } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import { transformPayload } from "./notification-payloads";
import { scrubOutboundHeaders } from "../lib/outbound-headers";

export interface NotificationServiceDeps {
  db: AppDb;
  fetch?: typeof globalThis.fetch;
  uiOrigin?: string;
}

export class NotificationService {
  private db: AppDb;
  private fetchFn: typeof globalThis.fetch;
  private uiOrigin: string;

  constructor(deps: NotificationServiceDeps) {
    this.db = deps.db;
    this.fetchFn = deps.fetch || globalThis.fetch;
    this.uiOrigin = deps.uiOrigin ?? "";
  }

  /** Register handlers for all notification events on the given EventBus */
  register(eventBus: EventBus): void {
    for (const event of NOTIFICATION_EVENTS) {
      eventBus.on(event, (data) => this.handleEvent(event, data));
    }
  }

  /**
   * The only record of whether a channel is actually reachable — dispatch
   * itself is fire-and-forget (no retry, no queue), so this row is where an
   * admin finds out a webhook has started failing instead of it going
   * silent forever. `error` is cleared on a success so the row never shows
   * a stale failure after the endpoint has recovered. Best-effort: a DB
   * write failure here must not throw back into the fire-and-forget chain
   * that called it.
   */
  private async recordDeliveryOutcome(
    channelId: string,
    status: "success" | "failed",
    error: string | null,
  ): Promise<void> {
    try {
      await this.db
        .update(notificationChannels)
        .set({ last_delivery_at: new Date(), last_delivery_status: status, last_error: error })
        .where(eq(notificationChannels.id, channelId));
    } catch (err) {
      console.error("Failed to record delivery outcome for channel %s:", channelId, err);
    }
  }

  private async handleEvent(event: NotificationEvent, data: EventData): Promise<void> {
    try {
      // Query active channels for this project that subscribe to this event
      const channels = await this.db
        .select()
        .from(notificationChannels)
        .where(
          and(
            eq(notificationChannels.project_id, data.project_id),
            eq(notificationChannels.is_active, true),
          ),
        );

      // Filter channels that have this event in their events array
      const matching = channels.filter((ch: any) => {
        const events = ch.events as string[];
        return Array.isArray(events) && events.includes(event);
      });

      // Fire webhooks (fire-and-forget). Each channel is isolated in its own try
      // block: a transform throw (e.g. a row whose `type` column outran the TS union
      // during a rolling deploy) or a fetch rejection for one channel must not abort
      // deliveries for the rest.
      for (const channel of matching) {
        const payload: NotificationPayload = {
          event,
          review_id: data.review_id,
          template: data.template,
          project: data.project_id,
          priority: data.priority,
          url: `/reviews/${data.review_id}`,
          created_at: data.created_at,
        };

        let wirePayload: unknown;
        const channelType = (channel.type as NotificationChannelType | null) ?? "generic";
        try {
          wirePayload = transformPayload(channelType, payload, { uiOrigin: this.uiOrigin });
        } catch (transformErr) {
          console.error(
            "Notification transform failed for channel %s (type=%s, event=%s):",
            channel.id,
            channelType,
            event,
            transformErr,
          );
          void this.recordDeliveryOutcome(channel.id, "failed", `Transform failed: ${String(transformErr)}`.slice(0, 300));
          continue;
        }

        const headers: Record<string, string> = {
          ...scrubOutboundHeaders(channel.headers as Record<string, string> | null),
          // Content-Type must come last so admin-supplied headers cannot override it.
          "Content-Type": "application/json",
        };

        // Resolve first, then inspect — fetch rejects only on network/DNS/abort, not
        // on HTTP 4xx/5xx. A Telegram 400 ("can't parse entities") or Discord 400
        // (oversize embed) returns a non-ok response that needs an explicit log.
        this.fetchFn(channel.webhook_url, {
          method: "POST",
          headers,
          body: JSON.stringify(wirePayload),
          // Prevent redirect-following so the redirect target is never reached without
          // re-validation by validateWebhookUrlWithDns (SSRF mitigation).
          redirect: "manual",
        })
          .then(async (response) => {
            if (!response.ok) {
              let bodyPreview = "";
              try {
                bodyPreview = (await response.text()).slice(0, 256);
              } catch {
                // body read failed — status alone is sufficient signal
              }
              console.error(
                "Notification delivery non-ok response from %s (channel=%s, type=%s, event=%s, status=%d %s): %s",
                channel.webhook_url,
                channel.id,
                channelType,
                event,
                response.status,
                response.statusText,
                bodyPreview,
              );
              await this.recordDeliveryOutcome(
                channel.id,
                "failed",
                `HTTP ${response.status} ${response.statusText}${bodyPreview ? `: ${bodyPreview}` : ""}`.slice(0, 300),
              );
            } else {
              await this.recordDeliveryOutcome(channel.id, "success", null);
            }
          })
          .catch((err) => {
            console.error(
              "Notification delivery failed to %s for event %s:",
              channel.webhook_url,
              event,
              err,
            );
            void this.recordDeliveryOutcome(
              channel.id,
              "failed",
              String(err instanceof Error ? err.message : err).slice(0, 300),
            );
          });
      }
    } catch (err) {
      console.error("Error processing notification event %s:", event, err);
    }
  }
}

import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { notificationChannels } from "@gatewerk/db/src/schema/index";
import {
  generateId,
  envelope,
  listEnvelope,
  InvalidRequestError,
  NotFoundError,
  WebhookCreateBodySchema,
  WebhookUpdateBodySchema,
  WebhookTestBodySchema,
  type WebhookTestBody,
  type NotificationChannelType,
  type NotificationPayload,
} from "@gatewerk/shared";
import { validateWebhookUrlWithDns } from "../../lib/ssrf";
import { scrubOutboundHeaders, truncatePreview } from "../../lib/outbound-headers";
import { resolveProjectId } from "../../lib/resolve-project-id";
import { requireRole } from "../../middleware/require-role";
import { validate } from "../../middleware/validate";
import { config } from "../../config";
import { transformPayload } from "../../services/notification-payloads";
import type { SettingsRouteDeps } from "./_deps";

/**
 * A notification webhook URL for an audit `details` blob: origin kept, path
 * dropped.
 *
 * The full URL cannot go in the ledger. A Slack or Discord incoming-webhook URL
 * carries its bearer credential IN THE PATH
 * (`hooks.slack.com/services/T…/B…/<secret>`), so recording it verbatim would
 * write a live credential into audit_log — which is admin-readable and, unlike
 * the notification_channels row, never rotated or redacted. The origin is the
 * part an investigation needs anyway: the question is which host project review
 * data is being sent to, not which channel within it.
 *
 * Unparseable input is reported as such rather than echoed, so a malformed value
 * can never smuggle the secret through this function.
 */
function auditableWebhookOrigin(url: unknown): string {
  if (typeof url !== "string" || url === "") return "<none>";
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<unparseable>";
  }
}

// Outgoing notification webhooks (Slack / Discord / generic HTTP) configured
// per-project. Independent of the HMAC signing secret (settings/hmac),
// which verifies incoming agent callbacks.
export function createSettingsWebhookRoutes(deps: SettingsRouteDeps): Router {
  const router = Router();
  const { db, auditService } = deps;

  /**
   * Actor for a notification-channel audit row. Matches the
   * `reviewer:<email>` convention used across routes/settings/**. Every route
   * here is requireRole("admin"), so a session reviewer is always present; the
   * fallback exists only so a missing email can never throw inside an audit
   * write and turn a config change into a 500.
   */
  const channelActor = (req: any): string =>
    `reviewer:${req.reviewer?.email ?? "unknown"}`;

  // GET /api/v1/settings/webhooks — admin only. The row includes
  // `webhook_url` and `headers` (which can contain bearer tokens for the
  // receiver); reviewers must not be able to enumerate these.
  router.get("/webhooks", requireRole("admin"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const webhooks = await db
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.project_id, projectId));

      res.json(listEnvelope("webhook", webhooks, { has_more: false, total: webhooks.length }));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/settings/webhooks — admin only. Mutates project-wide
  // outgoing-notification config; a non-admin redirect of webhook_url is a
  // review-event exfiltration path.
  router.post("/webhooks", requireRole("admin"), validate({ body: WebhookCreateBodySchema }), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const { name, webhook_url, events, headers, type } = req.body;

      if (!name || !webhook_url || !events) {
        throw new InvalidRequestError("Missing required fields: name, webhook_url, events", undefined, "missing_required_fields");
      }

      if (!Array.isArray(events) || events.length === 0) {
        throw new InvalidRequestError("events must be a non-empty array", "events", "invalid_events");
      }

      try {
        await validateWebhookUrlWithDns(webhook_url);
      } catch (err: any) {
        throw new InvalidRequestError(`Invalid webhook URL: ${err.message}`, "webhook_url", "invalid_webhook_url");
      }

      const [webhook] = await db
        .insert(notificationChannels)
        .values({
          id: generateId("webhook"),
          project_id: projectId,
          name,
          webhook_url,
          events,
          headers: headers || null,
          type: type ?? "generic",
        })
        .returning();

      // Tier 2 REQUIRED (services/AUDIT-WRITE-CONTRACT.md). Creating a channel
      // decides where review events are delivered from now on; only this row
      // records who opened that path. `headers` can hold a bearer token for the
      // receiver, so its NAMES are recorded and its values never are.
      if (auditService) {
        await auditService.log({
          action: "settings.changed",
          actor: channelActor(req),
          resource_type: "notification_channel",
          resource_id: webhook.id,
          details: {
            subject: "notification_webhook",
            operation: "created",
            name,
            type: webhook.type,
            webhook_url_origin: auditableWebhookOrigin(webhook.webhook_url),
            events,
            header_names: Object.keys((headers ?? {}) as Record<string, unknown>),
            ip: req.ip,
          },
          project_id: projectId,
        });
      }

      res.status(201).json(envelope("webhook", webhook));
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/v1/settings/webhooks/:id — admin only. See POST rationale.
  router.put("/webhooks/:id", requireRole("admin"), validate({ body: WebhookUpdateBodySchema }), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const { name, webhook_url, events, headers, is_active, type } = req.body;
      const updates: Record<string, any> = {};
      if (name !== undefined) updates.name = name;
      if (webhook_url !== undefined) {
        try {
          await validateWebhookUrlWithDns(webhook_url);
        } catch (err: any) {
          throw new InvalidRequestError(`Invalid webhook URL: ${err.message}`, "webhook_url", "invalid_webhook_url");
        }
        updates.webhook_url = webhook_url;
      }
      if (events !== undefined) updates.events = events;
      if (headers !== undefined) updates.headers = headers;
      if (is_active !== undefined) updates.is_active = is_active;
      if (type !== undefined) updates.type = type;

      const [updated] = await db
        .update(notificationChannels)
        .set(updates)
        .where(
          and(
            eq(notificationChannels.id, String(req.params.id)),
            eq(notificationChannels.project_id, projectId),
          ),
        )
        .returning();

      if (!updated) {
        throw new NotFoundError("Webhook not found", "webhook_not_found");
      }

      // Tier 2 REQUIRED. `is_active: false` silences delivery without deleting
      // the row, so this is the transition that explains a period of missing
      // notifications; `webhook_url` is the repoint that explains review data
      // arriving somewhere new. Header values stay out — see the POST rationale.
      if (auditService) {
        await auditService.log({
          action: "settings.changed",
          actor: channelActor(req),
          resource_type: "notification_channel",
          resource_id: updated.id,
          details: {
            subject: "notification_webhook",
            operation: "updated",
            changed_keys: Object.keys(updates),
            name: updated.name,
            type: updated.type,
            is_active: updated.is_active,
            ...(webhook_url !== undefined
              ? { webhook_url_origin: auditableWebhookOrigin(updated.webhook_url) }
              : {}),
            ...(events !== undefined ? { events } : {}),
            ...(headers !== undefined
              ? { header_names: Object.keys((headers ?? {}) as Record<string, unknown>) }
              : {}),
            ip: req.ip,
          },
          project_id: projectId,
        });
      }

      res.json(envelope("webhook", updated));
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/v1/settings/webhooks/:id — admin only. Silencing notifications
  // is a sensitive config mutation; see POST rationale.
  router.delete("/webhooks/:id", requireRole("admin"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const [deleted] = await db
        .delete(notificationChannels)
        .where(
          and(
            eq(notificationChannels.id, String(req.params.id)),
            eq(notificationChannels.project_id, projectId),
          ),
        )
        .returning();

      if (!deleted) {
        throw new NotFoundError("Webhook not found", "webhook_not_found");
      }

      // Tier 2 REQUIRED. A hard DELETE: after this the row is gone, so this is
      // the ONLY surviving evidence the channel ever existed and that someone
      // silenced it. Recorded with the config it was carrying at the time.
      if (auditService) {
        await auditService.log({
          action: "settings.changed",
          actor: channelActor(req),
          resource_type: "notification_channel",
          resource_id: deleted.id,
          details: {
            subject: "notification_webhook",
            operation: "deleted",
            name: deleted.name,
            type: deleted.type,
            webhook_url_origin: auditableWebhookOrigin(deleted.webhook_url),
            events: deleted.events,
            was_active: deleted.is_active,
            ip: req.ip,
          },
          project_id: projectId,
        });
      }

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/settings/webhooks/test — admin only. Ephemeral: sends a synthetic
  // review.created payload to the supplied URL using the to-be-saved channel config.
  // No DB row created. Powers the "Send test payload" button on the create/edit form
  // so admins can validate Slack/etc. wiring before saving (Slack returns 200 to
  // mismatched payloads, making silent failure the worst-of-both-worlds UX).
  router.post("/webhooks/test", requireRole("admin"), validate({ body: WebhookTestBodySchema }), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const { webhook_url, type, headers } = req.body as WebhookTestBody;

      try {
        await validateWebhookUrlWithDns(webhook_url);
      } catch (err: any) {
        throw new InvalidRequestError(`Invalid webhook URL: ${err.message}`, "webhook_url", "invalid_webhook_url");
      }

      const syntheticPayload: NotificationPayload = {
        event: "review.created",
        review_id: "test_review_synthetic",
        template: "test_template",
        project: projectId,
        priority: "normal",
        url: "/reviews/test_review_synthetic",
        created_at: new Date().toISOString(),
      };

      const channelType = (type ?? "generic") as NotificationChannelType;
      let wirePayload: unknown;
      try {
        wirePayload = transformPayload(channelType, syntheticPayload, { uiOrigin: config.uiOrigin });
      } catch (transformErr: any) {
        // Surface unsupported-type as structured `{ok:false}` rather than an opaque
        // 500 so the admin sees the same "Send test" failure UI as a network error.
        // Zod normally constrains `type` to the union; this catches the case where
        // a future schema relaxation or direct cast lets a stray value through.
        res.json({
          ok: false,
          status: 0,
          status_text: `Unsupported channel type: ${String(channelType)}`,
          response_preview: "",
          latency_ms: 0,
        });
        return;
      }

      const outboundHeaders: Record<string, string> = {
        ...scrubOutboundHeaders(headers as Record<string, string> | null),
        // Content-Type must come last so admin-supplied headers cannot override it.
        "Content-Type": "application/json",
      };

      const startedAt = Date.now();
      let httpStatus = 0;
      let statusText = "";
      let bodyPreview = "";
      let ok = false;
      try {
        const response = await fetch(webhook_url, {
          method: "POST",
          headers: outboundHeaders,
          body: JSON.stringify(wirePayload),
          // Prevent redirect-following so the redirect target is never reached without
          // re-validation by validateWebhookUrlWithDns (SSRF + response-oracle mitigation).
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        // Capture status before attempting body read — a socket hang-up mid-body must
        // not reset these to 0 (the HTTP response was received).
        httpStatus = response.status;
        statusText = response.statusText;
        ok = response.ok;
        try {
          const text = await response.text();
          bodyPreview = truncatePreview(text);
        } catch (bodyErr: any) {
          bodyPreview = `<failed to read body: ${bodyErr?.message ?? "unknown"}>`;
        }
      } catch (err: any) {
        // Request-level failure (timeout, network, DNS, abort). httpStatus stays at
        // its initial 0 so the UI can distinguish "no HTTP response" from "HTTP
        // 200 with unreadable body".
        httpStatus = 0;
        statusText = err?.name === "TimeoutError" ? "Request timed out after 10s" : (err?.message ?? "Network error");
        bodyPreview = "";
        ok = false;
      }

      const latencyMs = Date.now() - startedAt;

      res.json({
        ok,
        status: httpStatus,
        status_text: statusText,
        response_preview: bodyPreview,
        latency_ms: latencyMs,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

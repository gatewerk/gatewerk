import { Router } from "express";
import { config } from "../../config";
import { requireRole } from "../../middleware/require-role";
import { validate } from "../../middleware/validate";
import { EmailTestBodySchema, type EmailTestBody, type EmailStatusResponse, type EmailTestResponse } from "@gatewerk/shared";
import type { SettingsRouteDeps } from "./_deps";
import { renderEmail, TestEmail } from "@gatewerk/emails";

/**
 * Admin-facing surface for diagnosing outbound email. Two endpoints under
 * /api/v1/settings/email — both admin-only, both return JSON typed against
 * shared zod schemas, neither returns secret values (passwords, API keys).
 */

/** Per-admin Send-test cap: 10 calls per 60s window. The service layer
 *  intentionally bypasses its own rate-limit and idempotency so an admin
 *  can hammer the button while debugging — but unbounded admin sends become
 *  a quota-burn / phishing vector via Resend or the configured SMTP relay.
 *  Coarse route-level cap closes that with little impact on real diagnostic
 *  use. Keyed by reviewer id so distinct admins don't share a window. */
const TEST_RATE_LIMIT_MAX = 10;
const TEST_RATE_LIMIT_WINDOW_MS = 60_000;
const testHits = new Map<string, number[]>();

function consumeTestRateLimit(reviewerId: string): boolean {
  const now = Date.now();
  const cutoff = now - TEST_RATE_LIMIT_WINDOW_MS;
  const prior = (testHits.get(reviewerId) ?? []).filter((t) => t >= cutoff);
  if (prior.length >= TEST_RATE_LIMIT_MAX) {
    testHits.set(reviewerId, prior);
    return false;
  }
  prior.push(now);
  testHits.set(reviewerId, prior);
  return true;
}

export function createSettingsEmailRoutes(deps: SettingsRouteDeps): Router {
  const router = Router();

  router.get("/email/status", requireRole("admin"), async (_req, res, next) => {
    try {
      if (!deps.emailService) {
        // Bootstrapping shape: rather than 500-via-throw, return a structured
        // 503 so the UI renders the same "unavailable" branch as a stuck
        // transport rather than a global error toast.
        res.status(503).json({
          transport: "none",
          configured: false,
          resend_configured: false,
        } satisfies EmailStatusResponse);
        return;
      }

      const smtp = config.smtp;
      const transport = deps.emailService.getTransportKind();

      let response: EmailStatusResponse;
      if (transport === "smtp" && smtp.host && smtp.port && smtp.from) {
        response = {
          transport: "smtp",
          configured: true,
          smtp: {
            host: smtp.host,
            port: smtp.port,
            from: smtp.from,
            auth: Boolean(smtp.user && smtp.pass),
            secure: smtp.secure,
          },
          resend_configured: Boolean(config.resendApiKey),
        };
      } else if (transport === "resend") {
        response = {
          transport: "resend",
          configured: true,
          resend_configured: true,
        };
      } else {
        // Includes the predicate-drift case where service says "smtp" but
        // config.smtp triad is partially set — degrade to "none" with a log
        // rather than emit a structurally-invalid response.
        if (transport === "smtp") {
          console.warn(
            "[email/status] service reports transport=smtp but config.smtp missing host/port/from — reporting none",
          );
        }
        response = {
          transport: "none",
          configured: false,
          resend_configured: false,
        };
      }
      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  router.post("/email/test", requireRole("admin"), validate({ body: EmailTestBodySchema }), async (req, res, next) => {
    try {
      const { to } = req.body as EmailTestBody;
      const reviewerId = (req as any).reviewer?.id ?? "unknown";

      if (!deps.emailService) {
        res.status(503).json({
          status: "failed",
          error: "email_service_unavailable",
          latency_ms: 0,
        } satisfies EmailTestResponse);
        return;
      }

      if (!consumeTestRateLimit(reviewerId)) {
        res.status(429).json({
          status: "failed",
          error: `rate_limited (max ${TEST_RATE_LIMIT_MAX} per minute)`,
          latency_ms: 0,
        } satisfies EmailTestResponse);
        return;
      }

      const startedAt = Date.now();
      // The operator reading this test is checking whether the mark loaded and
      // the styling survived their client, so it must carry the same logo the
      // real mail does.
      const rendered = await renderEmail(TestEmail, {
        logoUrl: config.emailLogoUrl,
      });
      const result = await deps.emailService.sendTestEmail({ to, ...rendered });
      const latency_ms = Date.now() - startedAt;

      // Route-level audit emit carries the admin actor identity that the
      // service-layer "system:email" emit does not — without this row the
      // arbitrary-`to` test surface has no forensic record of WHO triggered it.
      if (deps.auditService) {
        try {
          await deps.auditService.log({
            action:
              result.status === "sent"
                ? "email.test_sent"
                : result.status === "skipped_no_config"
                  ? "email.test_skipped_no_config"
                  : "email.test_failed",
            actor: reviewerId,
            resource_type: "email",
            details: {
              to,
              status: result.status,
              latency_ms,
              source_ip: req.ip,
              ...(result.status === "sent" ? { message_id: result.messageId } : {}),
              ...(result.status === "failed" ? { error: result.error } : {}),
            },
          });
        } catch (e) {
          console.error("[email/test] route audit emit failed", e);
        }
      }

      const response: EmailTestResponse =
        result.status === "sent"
          ? { status: "sent", message_id: result.messageId, latency_ms }
          : result.status === "skipped_no_config"
            ? { status: "skipped_no_config", latency_ms }
            : { status: "failed", error: result.error, latency_ms };

      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

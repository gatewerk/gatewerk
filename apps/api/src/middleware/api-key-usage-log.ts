import type { Request, Response } from "express";
import type { AppDb } from "@gatewerk/db";
import { apiKeyUsage } from "@gatewerk/db/src/schema/index";

const SCHEDULED_FLAG = Symbol.for("gatewerk.apiKeyUsageScheduled");

/**
 * Attach a one-shot `res.on("finish")` hook that inserts a row into
 * `api_key_usage` after the response completes. Fire-and-forget: the insert
 * never blocks the response and swallows its own errors so a logging outage
 * can't cascade into request failure.
 *
 * Call this from both `apiKeyAuth` and the API-key branch of `dualAuth`
 * AFTER auth succeeds — only authed requests should produce telemetry.
 * Expired / IP-blocked / invalid-key rejections short-circuit before this
 * runs, which matches the spec's intent (telemetry = usage, not auth attempts).
 *
 * Idempotent: a few routes (`/feedback`, `/audit`, `/webhooks/deliveries`) are
 * mounted below `apiKeyAuth` but `dualAuth` still runs as outer middleware for
 * the shared `/api/v1` prefix. Calling this twice on the same request would
 * double-log — the symbol flag on `req` guarantees one row per request.
 */
export function scheduleApiKeyUsageLog(
  db: AppDb,
  apiKeyId: string,
  req: Request,
  res: Response,
): void {
  const reqAny = req as any;
  if (reqAny[SCHEDULED_FLAG]) return;
  reqAny[SCHEDULED_FLAG] = true;

  const endpoint = (req.originalUrl || req.url || req.path).split("?")[0];
  const method = req.method;

  res.on("finish", () => {
    db.insert(apiKeyUsage).values({
      api_key_id: apiKeyId,
      endpoint,
      method,
      status_code: res.statusCode,
    }).catch(() => {
      // Intentional: logging failure must not surface to the client or crash
      // the worker. Lost rows are acceptable vs a response-time hit.
    });
  });
}

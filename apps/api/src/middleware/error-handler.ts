import { STATUS_CODES } from "node:http";
import type { Request, Response, NextFunction } from "express";
import { GatewerkError } from "@gatewerk/shared";
import { serverEnv } from "../env";

let reportError: ((err: Error, req: Request) => void) | null = null;

if (serverEnv.GATEWERK_MODE === "cloud") {
  const sentryPath = (): string => new URL("../../../../ee/api/monitoring/sentry.js", import.meta.url).href;
  import(sentryPath())
    .then((m: { captureException: (err: Error) => void; withScope: (cb: (scope: any) => void) => void }) => {
      reportError = (err: Error, req: Request) => {
        m.withScope((scope: any) => {
          const reviewer = (req as any).reviewer;
          if (reviewer) scope.setUser({ id: reviewer.id });
          scope.setTag("route", `${req.method} ${req.route?.path ?? req.path}`);
          scope.setTag("auth_type", (req as any).authType ?? "none");
          m.captureException(err);
        });
      };
    })
    .catch(() => {});
}

/** Test-only: lets the suite observe the Sentry gate without ee/ or cloud mode. No-op outside NODE_ENV=test so it cannot disable reporting in a running deployment. */
export function _setReportErrorForTest(fn: ((err: Error, req: Request) => void) | null) {
  if (serverEnv.NODE_ENV !== "test") return;
  reportError = fn;
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  // Production logs ship to operators / Sentry / aggregators where full
  // stack traces leak file paths, function names, and SQL error messages
  // that can carry schema info. In prod we log a compact one-liner (the
  // request_id is the join key for Sentry); dev keeps the full trace for
  // ergonomics. Expected user-input errors (GatewerkError < 500) are not
  // logged at error level at all — they show up in the access log as 4xx.
  const isProd = serverEnv.NODE_ENV === "production";
  // Status is resolved once, the same way for every error class: a
  // GatewerkError carries its own statusCode; anything else (body-parser
  // SyntaxError/PayloadTooLarge, plain Errors with a status attached) falls
  // back to status/statusCode/500. 501 is treated as expected alongside
  // every < 500 status: it signals a feature deliberately not configured on
  // this instance (e.g. TOTP without TOTP_ENCRYPTION_KEY) or a client-caused
  // input error (malformed JSON, oversized body), not a fault worth a stack
  // trace or Sentry event.
  const status = err instanceof GatewerkError ? err.statusCode : ((err as any).status || (err as any).statusCode || 500);
  const isExpected = status < 500 || status === 501;
  if (!isExpected) {
    // Self-hosted deployments have no Sentry — it lives in ee/ and is gated on
    // cloud mode — so the compact one-liner WAS the entire record of a 500, and
    // it is not enough to debug one. The operator owns the host and the log, so
    // the leak argument above does not apply to them the way it does to a
    // shared aggregator. Cloud keeps the one-liner: Sentry already has the
    // stack, joined on request_id.
    const shipsToSentry = serverEnv.GATEWERK_MODE === "cloud";
    if (isProd && shipsToSentry) {
      console.error(
        `[error] request_id=${req.requestId} name=${err.name} message=${err.message}`,
      );
    } else if (isProd) {
      console.error(
        `[error] request_id=${req.requestId} name=${err.name} message=${err.message}\n${err.stack ?? "(no stack)"}`,
      );
    } else {
      console.error(err);
    }
  }

  if (err instanceof GatewerkError) {
    if (!isExpected && reportError) reportError(err, req);
    return res.status(err.statusCode).json(err.toJSON());
  }

  if (!isExpected && reportError) reportError(err, req);

  res.status(status).json({
    error: {
      type: "internal_error",
      code: "internal_error",
      message: status === 500 ? "Something went wrong" : (STATUS_CODES[status] ?? "Request failed"),
      doc_url: "https://docs.gatewerk.dev/errors/internal_error",
    },
  });
}

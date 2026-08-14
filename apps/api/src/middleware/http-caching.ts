import type { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";

// Paths that must never be cached: token-review links are single-use and
// security-sensitive (expiry/consumption state must always hit the server).
const SKIP_PREFIXES = ["/r/", "/api/v1/r/"];

const NO_STORE_PREFIXES = [
  "/api/v1/auth/",
  "/api/v1/settings/hmac-secret",
];

function shouldSkip(originalUrl: string): boolean {
  const pathOnly = originalUrl.split("?")[0];
  return SKIP_PREFIXES.some((p) => pathOnly.startsWith(p));
}

function shouldNoStore(originalUrl: string): boolean {
  const pathOnly = originalUrl.split("?")[0];
  return NO_STORE_PREFIXES.some((p) => pathOnly.startsWith(p));
}

function computeStrongEtag(body: unknown): string {
  const serialized =
    typeof body === "string"
      ? body
      : body instanceof Buffer
      ? body.toString("utf8")
      : JSON.stringify(body);
  const digest = createHash("sha256").update(serialized).digest("base64url").slice(0, 27);
  return `"${digest}"`;
}

/**
 * ETag + Cache-Control for GET endpoints.
 *
 * - Strong validators only (no `W/` prefix).
 * - GET only — POST/PATCH/DELETE bypass.
 * - Skips one-time-use token-review routes (`/r/*`, `/api/v1/r/*`).
 * - For list endpoints, hashing the full JSON body automatically captures
 *   the `total` count (the count is part of the body), so mutations that
 *   change `total` naturally invalidate the cache.
 * - `Cache-Control: private, no-cache` forces browser/proxy to revalidate
 *   with `If-None-Match` on every request — giving us 304 savings without
 *   stale reads.
 */
export function httpCaching() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") return next();
    if (shouldSkip(req.originalUrl || req.url)) return next();

    // We wrap res.json() rather than intercepting at the transport layer.
    // Limitation: routes that bypass res.json() (e.g. res.send(buffer) for binary
    // payloads, res.sendFile(), streamed responses) do NOT get an ETag. Every
    // current route uses res.json(); revisit this wrap if that changes.
    const originalJson = res.json.bind(res);
    res.json = function patchedJson(body: unknown) {
      if (res.headersSent) return originalJson(body);

      const etag = computeStrongEtag(body);
      res.setHeader("ETag", etag);
      if (!res.getHeader("Cache-Control")) {
        res.setHeader(
          "Cache-Control",
          shouldNoStore(req.originalUrl || req.url) ? "no-store" : "private, no-cache",
        );
      }

      const ifNoneMatch = req.header("if-none-match");
      if (ifNoneMatch && ifNoneMatch === etag) {
        res.status(304);
        res.removeHeader("Content-Type");
        res.removeHeader("Content-Length");
        return res.end();
      }

      return originalJson(body);
    } as Response["json"];

    next();
  };
}

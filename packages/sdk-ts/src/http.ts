// Shared retry helper for SDK resources. Every resource (reviews/chains/notes/...)
// used to duplicate a `request<T>` method with no retry logic, so transient
// 503s and rate limits surfaced as immediate failures to callers — diverging
// from sdk-py, which retries with exponential backoff in _base.py. This file
// ports the sdk-py contract:
//
//   - retry on {429, 500, 502, 503, 504} and on network errors
//   - exponential backoff: min(1000 * 2 ** attempt, 30000) ms with +-20% jitter
//   - honor Retry-After header for 429 (parses both seconds and HTTP-date)
//   - default maxRetries = 2 (3 attempts total: initial + 2 retries)
//   - identity-preserving Result<T> shape from errors.ts
//
// Resources opt in by calling `retryingRequest(...)` instead of their inline
// `fetch` block. reviews / chains / notes use it; audit / feedback / stats /
// templates / webhooks still use the inline implementation.

import type { Result, GatewerkApiError } from "./errors.js";
import { success, failure } from "./errors.js";

const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;

export interface RetryingRequestOptions {
  /**
   * Total retry attempts on top of the initial request. Default 2 (so 3
   * total attempts). Set to 0 to disable retries entirely (matches a raw
   * fetch).
   */
  maxRetries?: number;
}

/**
 * Parse a Retry-After header value. Servers may send either:
 *   - integer seconds (e.g. "120")
 *   - HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
 * Returns the delay in milliseconds, or null if unparseable / missing.
 */
function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  // seconds form
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  // HTTP-date form
  const targetMs = Date.parse(trimmed);
  if (!Number.isNaN(targetMs)) {
    const delta = targetMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

/**
 * Exponential backoff with +-20% jitter, capped at DEFAULT_MAX_DELAY_MS.
 * `attempt` is 0-indexed (first retry uses attempt=0 -> ~1s).
 */
function calculateBackoff(attempt: number): number {
  const exponential = Math.min(DEFAULT_BASE_DELAY_MS * 2 ** attempt, DEFAULT_MAX_DELAY_MS);
  const jitterFactor = 1 + (Math.random() * 0.4 - 0.2); // 0.8..1.2
  return exponential * jitterFactor;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Headers may be provided as a Headers instance, plain object, or array of
 * pairs (RequestInit accepts all three). Read `Retry-After` portably.
 */
function getRetryAfterHeader(res: Response): string | null {
  // Response.headers is always a Headers instance per fetch spec.
  return res.headers.get("retry-after");
}

/**
 * Request helper used by every resource. Performs the fetch, decodes JSON
 * (or treats 204 as empty), maps non-2xx into the standard
 * GatewerkApiError shape, and retries transient failures with exponential
 * backoff + jitter.
 *
 * Resources retain control over the URL, method, body, and headers — this
 * helper only wraps the timing + retry + error-mapping concerns.
 */
export async function retryingRequest<T>(
  url: string,
  init: RequestInit | undefined,
  baseHeaders: () => Record<string, string>,
  options?: RetryingRequestOptions,
): Promise<Result<T>> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

  let lastNetworkError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { ...baseHeaders(), ...init?.headers },
      });

      // 204 No Content (DELETE handlers) — no body to parse.
      if (res.status === 204) {
        return success<T>(undefined as unknown as T);
      }

      // Read the body once. We need it both on success (return) and on
      // mappable error (extract code/message). Some retryable 5xx may
      // have empty bodies — guard with try/catch.
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      if (res.ok) {
        return success<T>(body as T);
      }

      // Non-2xx. Decide retry vs fail-fast.
      if (RETRYABLE_STATUS_CODES.has(res.status) && attempt < maxRetries) {
        const retryAfterMs = res.status === 429 ? parseRetryAfter(getRetryAfterHeader(res)) : null;
        const delayMs = retryAfterMs ?? calculateBackoff(attempt);
        await sleep(delayMs);
        continue;
      }

      const apiError = (body && body.error) || {};
      const err: GatewerkApiError = {
        type: apiError.type || "api_error",
        code: apiError.code || "unknown",
        message: apiError.message || `Request failed with status ${res.status}`,
        statusCode: res.status,
        param: apiError.param,
        doc_url: apiError.doc_url,
      };
      return failure<T>(err);
    } catch (err) {
      // Network error path (TypeError from fetch on dead socket / CORS /
      // DNS / connection refused). Retry per RETRYABLE_STATUS_CODES policy
      // — the request never reached a server so any transient cause might
      // resolve on the next attempt.
      lastNetworkError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delayMs = calculateBackoff(attempt);
        await sleep(delayMs);
        continue;
      }
      return failure<T>({
        type: "network_error",
        code: "network_error",
        message: lastNetworkError.message || "Network error",
        statusCode: 0,
      });
    }
  }

  // Exhausted retries without a successful return — only reachable from
  // the retryable-status path that fell through the loop.
  return failure<T>({
    type: "api_error",
    code: "unknown",
    message: lastNetworkError?.message || "Request failed after retries",
    statusCode: 0,
  });
}

// Uses node:crypto directly (not lib/crypto.ts) because the project's HMAC
// wrapper provides hex + base64url helpers but not standard base64.
// Extending lib/crypto would change its output-type contract, so we keep
// the wrapper boundary stable and import createHmac directly here.

import { createHmac, timingSafeEqual } from "crypto";
import { assertNever } from "@gatewerk/shared";

/**
 * Standard Webhooks signing utilities.
 * Spec: https://www.standardwebhooks.com
 *
 * The Standard Webhooks specification defines three headers for every delivery:
 *   webhook-id        — stable delivery ID (same across retries)
 *   webhook-timestamp — Unix seconds as string
 *   webhook-signature — space-separated list of `v1,<base64>` signatures
 *
 * Signed content: `${webhookId}\n${webhookTimestamp}\n${body}`
 * HMAC algorithm: SHA-256
 * Encoding: standard base64 (RFC 4648 §4) — NOT base64url
 *
 * Multiple signatures support key rotation: receivers accept a delivery if
 * ANY signature validates. Example with two keys:
 *   webhook-signature: v1,<sig-new-key> v1,<sig-old-key>
 */

export interface StandardWebhookHeaders {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
}

/**
 * Compute a single Standard Webhooks signature for the given inputs.
 * Returns the raw base64 string (without the `v1,` prefix).
 */
export function computeSwhSignature(
  webhookId: string,
  timestampSeconds: number,
  body: string,
  secret: string,
): string {
  const toSign = `${webhookId}\n${timestampSeconds}\n${body}`;
  return createHmac("sha256", secret).update(toSign).digest("base64");
}

/**
 * Build the three Standard Webhooks headers for a single signing key.
 * For key rotation (multiple keys), use `buildSwhHeadersMultiKey`.
 */
export function buildSwhHeaders(
  webhookId: string,
  body: string,
  secret: string,
  timestampSeconds?: number,
): StandardWebhookHeaders {
  const ts = timestampSeconds ?? Math.floor(Date.now() / 1000);
  const sig = computeSwhSignature(webhookId, ts, body, secret);
  return {
    "webhook-id": webhookId,
    "webhook-timestamp": String(ts),
    "webhook-signature": `v1,${sig}`,
  };
}

/**
 * Build Standard Webhooks headers for multiple signing keys (key rotation).
 * All signatures are included in `webhook-signature` (space-separated).
 * Receivers accept the delivery if any signature is valid.
 */
export function buildSwhHeadersMultiKey(
  webhookId: string,
  body: string,
  secrets: string[],
  timestampSeconds?: number,
): StandardWebhookHeaders {
  const ts = timestampSeconds ?? Math.floor(Date.now() / 1000);
  const sigs = secrets
    .map((secret) => `v1,${computeSwhSignature(webhookId, ts, body, secret)}`)
    .join(" ");
  return {
    "webhook-id": webhookId,
    "webhook-timestamp": String(ts),
    "webhook-signature": sigs,
  };
}

/**
 * Verify a Standard Webhooks signature. Returns true if any of the provided
 * secrets produces a matching signature. Constant-time comparison prevents
 * timing attacks.
 *
 * `toleranceSeconds` defaults to 300 (5 minutes) per the spec recommendation.
 */
export function verifySwhSignature(opts: {
  webhookId: string;
  webhookTimestamp: string;
  webhookSignature: string;
  body: string;
  secrets: string[];
  toleranceSeconds?: number;
}): boolean {
  const ts = Number(opts.webhookTimestamp);
  if (!Number.isInteger(ts)) return false;

  const tolerance = opts.toleranceSeconds ?? 300;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > tolerance) return false;

  const provided = opts.webhookSignature
    .split(" ")
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice(3));

  for (const secret of opts.secrets) {
    const expectedBuf = Buffer.from(computeSwhSignature(opts.webhookId, ts, opts.body, secret), "base64");
    for (const sig of provided) {
      const sigBuf = Buffer.from(sig, "base64");
      // timingSafeEqual REQUIRES equal-length buffers; length-guard prevents throw.
      if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Key rotation semantics.
 *
 * Intended rotation flow:
 *   On rotate:
 *     1. Mark existing 'active' key as 'previous' with rotated_at = now().
 *     2. Insert new 'active' key.
 *   On delivery signing:
 *     - Query 'active' + any 'previous' key where rotated_at > now() - 24h.
 *     - Pass both secrets to `buildSwhHeadersMultiKey`.
 *     - Receivers see two `v1,<sig>` values and accept either.
 *   On TTL expiry (background job or on-demand):
 *     - Mark 'previous' keys where rotated_at < now() - 24h as 'revoked'.
 *
 * Helpers operate on plain objects. The caller is responsible for querying
 * signing keys (typically the route handler or a dedicated rotation service)
 * and for transactional rotation (the partial unique index in migration 062
 * makes non-transactional 'mark previous + insert active' transiently fail).
 */
export interface SigningKeyRecord {
  id: string;
  project_id: string;
  key_id: string;
  secret: string;
  status: "active" | "previous" | "revoked";
  rotated_at: Date | null;
  created_at: Date;
}

/**
 * Compute which secrets are currently valid for signing (active + unexpired previous).
 * Pass the result array to `buildSwhHeadersMultiKey`.
 *
 * `overlapMs` defaults to 24 hours.
 */
export function resolveActiveSecrets(
  keys: SigningKeyRecord[],
  overlapMs = 24 * 60 * 60 * 1000,
): string[] {
  const now = Date.now();
  return keys
    .filter((k) => {
      switch (k.status) {
        case "active":
          return true;
        case "previous":
          if (!k.rotated_at) return false;
          return now - k.rotated_at.getTime() < overlapMs;
        case "revoked":
          return false;
        default:
          assertNever(k.status);
      }
    })
    .map((k) => k.secret);
}

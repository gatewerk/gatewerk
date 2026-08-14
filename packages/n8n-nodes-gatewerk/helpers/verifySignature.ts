import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify a Gatewerk webhook signature header against the raw request body.
 *
 * Mirrors the sender at apps/api/src/services/webhooks.ts. The Gatewerk API
 * emits two HMAC signatures on every delivery:
 *
 *   X-Webhook-Signature    — v1 legacy: `sha256=<hex>` of HMAC-SHA256(body, secret).
 *                             No replay protection, but simple to verify.
 *   X-Webhook-Signature-V2 — v2 replay-safe: `t=<unix-seconds>,v1=<hex>` where
 *                             hex = HMAC-SHA256(`${t}.${body}`, secret).
 *                             Receivers verify freshness via `t` then HMAC.
 *
 * This verifier accepts EITHER header. v2 is preferred when present because
 * it carries replay protection; we fall through to v1 if v2 is missing.
 *
 * Both comparisons use crypto.timingSafeEqual to defend against timing
 * attacks; never use `===` for HMAC compare.
 */

export interface VerifySignatureInput {
  /** Raw request body bytes (NOT a parsed object — re-stringifying loses key order). */
  rawBody: Buffer | string;
  /** Header value of `X-Webhook-Signature` (legacy v1), if present. */
  v1Header?: string | string[] | undefined;
  /** Header value of `X-Webhook-Signature-V2` (Stripe-style envelope), if present. */
  v2Header?: string | string[] | undefined;
  /** Shared secret configured in the Gatewerk project. */
  secret: string;
  /** Max permitted clock skew for v2 timestamps, in seconds. Default 300 (5 min). */
  toleranceSeconds?: number;
  /** Override `now` for deterministic tests. Defaults to `Date.now()`. */
  nowMs?: number;
}

export type VerifySignatureResult =
  | { ok: true; variant: 'v1' | 'v2' }
  | { ok: false; reason: string };

function pickHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function bufferEqualConstantTime(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length Buffers; bail fast on length
  // mismatch. The length itself isn't secret (it's the hex of a fixed-size
  // digest), so an early return doesn't leak.
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

export function verifyGatewerkSignature(input: VerifySignatureInput): VerifySignatureResult {
  const v1 = pickHeader(input.v1Header);
  const v2 = pickHeader(input.v2Header);

  if (!v1 && !v2) {
    return { ok: false, reason: 'missing_signature_header' };
  }

  const bodyStr = typeof input.rawBody === 'string'
    ? input.rawBody
    : input.rawBody.toString('utf8');
  const tolerance = input.toleranceSeconds ?? 300;
  const nowMs = input.nowMs ?? Date.now();

  // Prefer v2 — it carries replay protection.
  if (v2) {
    // Format: `t=<unix-seconds>,v1=<hex>`
    const parts = v2.split(',').map(p => p.trim());
    let ts: number | undefined;
    let v2Hex: string | undefined;
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const key = part.slice(0, eq);
      const value = part.slice(eq + 1);
      if (key === 't') ts = Number.parseInt(value, 10);
      else if (key === 'v1') v2Hex = value;
    }
    if (!ts || Number.isNaN(ts) || !v2Hex) {
      return { ok: false, reason: 'malformed_v2_signature' };
    }
    const skewSeconds = Math.abs(Math.floor(nowMs / 1000) - ts);
    if (skewSeconds > tolerance) {
      return { ok: false, reason: 'timestamp_outside_tolerance' };
    }
    const expected = createHmac('sha256', input.secret)
      .update(`${ts}.${bodyStr}`)
      .digest('hex');
    if (bufferEqualConstantTime(expected, v2Hex)) {
      return { ok: true, variant: 'v2' };
    }
    return { ok: false, reason: 'v2_hmac_mismatch' };
  }

  // Fall through to v1.
  // Format: `sha256=<hex>`
  const v1Trimmed = v1!.trim();
  const prefix = 'sha256=';
  if (!v1Trimmed.startsWith(prefix)) {
    return { ok: false, reason: 'malformed_v1_signature' };
  }
  const v1Hex = v1Trimmed.slice(prefix.length);
  const expected = createHmac('sha256', input.secret).update(bodyStr).digest('hex');
  if (bufferEqualConstantTime(expected, v1Hex)) {
    return { ok: true, variant: 'v1' };
  }
  return { ok: false, reason: 'v1_hmac_mismatch' };
}

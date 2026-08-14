/**
 * Shared cryptographic helpers using @noble/hashes.
 *
 * @noble/hashes is a zero-dependency, audited TypeScript cryptography library
 * (https://github.com/paulmillr/noble-hashes). It produces byte-for-byte
 * identical output to Node's crypto.createHmac/createHash for the same inputs,
 * making it a safe drop-in (parity verified by lib/__tests__/crypto.test.ts).
 *
 * Scope:
 *   hmacSha256         — keyed HMAC-SHA256, hex output. Replaces createHmac calls
 *                        in audit.ts, webhooks.ts, email-otp/codes.ts.
 *   hmacSha256Base64url — keyed HMAC-SHA256, base64url output. Replaces the
 *                        createHmac(...).digest("base64url") call in email-tokens.ts.
 *   constantTimeEqual  — timing-safe string comparison. Replaces timingSafeEqual calls
 *                        in email-tokens.ts and email-otp/codes.ts.
 *
 * Out of scope: non-keyed SHA-256 (createHash). Those call sites (API key hashing,
 * token hashing, ETag generation) use Node crypto and are not security-sensitive
 * in the HMAC sense — leaving them untouched avoids unnecessary churn.
 *
 * Out of scope: crypto.randomInt — not provided by @noble/hashes; retained from
 * node:crypto in callers that need it.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Compute HMAC-SHA256(key, data) and return the result as a lowercase hex string.
 *
 * Both key and data are treated as UTF-8 strings. The output is identical to:
 *   crypto.createHmac("sha256", key).update(data).digest("hex")
 */
export function hmacSha256(key: string, data: string): string {
  const mac = hmac(sha256, utf8ToBytes(key), utf8ToBytes(data));
  return bytesToHex(mac);
}

/**
 * Compute HMAC-SHA256(key, data) and return the result as a base64url string.
 *
 * Both key and data are treated as UTF-8 strings. The output is identical to:
 *   crypto.createHmac("sha256", key).update(data).digest("base64url")
 *
 * Used exclusively by lib/email-tokens.ts where the link token format embeds
 * the signature as base64url (not hex) for URL-safety.
 */
export function hmacSha256Base64url(key: string, data: string): string {
  const mac = hmac(sha256, utf8ToBytes(key), utf8ToBytes(data));
  // base64url: standard base64 with + → -, / → _, trailing = stripped
  const b64 = Buffer.from(mac).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Constant-time comparison of two strings.
 *
 * Returns true iff a === b in constant time on equal-length inputs.
 *
 * Implementation: classic XOR-and-OR accumulator over the UTF-8 byte arrays.
 * The loop ALWAYS runs `aBytes.length` iterations regardless of where the
 * first byte difference appears, preventing timing-oracle attacks on the MAC.
 *
 * Length-mismatch contract: returns `false` (no throw). This is a deliberate
 * improvement over Node `crypto.timingSafeEqual` which throws `RangeError` on
 * length mismatch. All callers pass equal-length fixed-format outputs (64-char
 * SHA-256 hex, 43-char SHA-256 base64url) so the divergence is non-load-bearing
 * — and returning false on length mismatch is not a timing oracle because the
 * length of a correct HMAC output is fixed and public knowledge.
 *
 * @noble/hashes 2.x removed the `equalBytes` util it used to expose; the
 * inline loop is the standard portable pattern and avoids a util-version
 * dependency surface.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBytes = utf8ToBytes(a);
  const bBytes = utf8ToBytes(b);
  if (aBytes.length !== bBytes.length) return false; // defensive — different UTF-8 byte lengths
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

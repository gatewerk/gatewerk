import { randomInt } from "node:crypto";
import { hmacSha256, constantTimeEqual } from "../../lib/crypto";
import { config } from "../../config";

/**
 * OTP code generation + hashing for the email-OTP recipient flow.
 *
 * Generation:
 *   - 6-digit numeric code via crypto.randomInt (CSPRNG, uniform
 *     distribution). NIST SP 800-63B Rev.4 §5.1.3.2 (Restricted
 *     Authenticator) requires at least 10^6 possible values for short-
 *     lived OOB authenticators.
 *   - Drawn from [0, 1_000_000) and zero-padded to 6 digits to keep the
 *     keyspace fully uniform — drawing from [100_000, 1_000_000) would
 *     skew distribution by excluding leading-zero codes.
 *
 * Hashing:
 *   - HMAC-SHA256 using OTP_HMAC_SECRET (separate from JWT_SECRET to
 *     limit blast radius on key compromise — recipient OTP hashes vs
 *     reviewer session signing have different rotation cadences).
 *   - NOT bcrypt: 10-minute TTL + 5-attempt cap means brute-force cost
 *     is dominated by the attempt cap, not hash cost. HMAC is the
 *     Stripe / Auth0 / Clerk pattern for short-TTL OTPs; bcrypt's
 *     adaptive cost would burn server CPU per /verify call without
 *     adding meaningful security.
 *
 * Comparison:
 *   - constant-time via lib/crypto.constantTimeEqual; both strings are
 *     produced by the same hash function so they are always identical
 *     length (64-char SHA-256 hex). We hash the input regardless of
 *     caller-side shape and compare the resulting fixed-length hex digests.
 */

export function generateOtpCode(): string {
  // randomInt is half-open [min, max); pull from [0, 1_000_000) so the
  // full 6-digit space is uniformly distributed (including codes with
  // leading zeros — a [100000, 1000000) draw would silently exclude
  // 100,000 valid codes and skew the distribution).
  const n = randomInt(0, 1_000_000);
  return n.toString().padStart(6, "0");
}

export function hashOtpCode(code: string): string {
  return hmacSha256(config.otpHmacSecret, code);
}

/**
 * Constant-time comparison of an input code against a stored hash.
 *
 * Inputs of unexpected shape (non-numeric, wrong length) are still
 * hashed end-to-end so the function timing path is invariant — a
 * length-mismatch input does not short-circuit to false before the
 * hash work, which would leak shape information via timing.
 *
 * Returns false on mismatch. Length mismatch cannot occur in practice since
 * SHA-256 hashes are always 64 hex chars.
 */
export function verifyOtpCode(input: string, storedHash: string): boolean {
  // Hash the input regardless of shape — preserves constant-time path for
  // malformed inputs. Both results are fixed-length 64-char SHA-256 hex, so
  // constantTimeEqual's length-mismatch early-exit is non-load-bearing.
  const inputHash = hashOtpCode(input);
  return constantTimeEqual(inputHash, storedHash);
}

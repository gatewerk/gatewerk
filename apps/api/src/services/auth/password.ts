/**
 * Password hashing — argon2id with bcrypt-fallback verifier.
 *
 * OWASP Password Storage Cheat Sheet 2025 params:
 *   algorithm : argon2id
 *   m (memory) : 19456 KiB (19 MiB)
 *   t (iterations) : 2
 *   p (parallelism) : 1
 *
 * Bcrypt legacy hashes ($2a$ / $2b$ prefix) are verified via bcryptjs and
 * `needsRehash: true` is returned so callers can transparently upgrade on
 * the next successful login.
 *
 * IMPORTANT: Do NOT use this module for backup-code hashing (totp.ts).
 * Backup codes are high-entropy random strings with short TTL — the cost
 * savings of bcrypt are intentional there. This module is strictly for
 * user-chosen passwords.
 */
import * as argon2 from "argon2";
import bcrypt from "bcryptjs";

export interface VerifyResult {
  valid: boolean;
  /**
   * true when the stored hash uses the legacy bcrypt format and the
   * password verified successfully. Callers should re-hash with argon2id
   * and persist the new hash immediately.
   */
  needsRehash: boolean;
}

/** Argon2id OWASP 2025 parameters. */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB in KiB
  timeCost: 2,
  parallelism: 1,
};

/** Hash a plaintext password with argon2id. */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Dispatch:
 *  - argon2id hash ($argon2id$ prefix) → argon2.verify()
 *  - bcrypt hash ($2a$ / $2b$ prefix)  → bcrypt.compare(); needsRehash=true on success
 */
export async function verifyPassword(
  storedHash: string,
  plain: string,
): Promise<VerifyResult> {
  if (storedHash.startsWith("$argon2id$")) {
    // Corrupted $argon2id$ hash → treat as wrong password to avoid information oracle.
    // Distinguishing "malformed hash" from "wrong password" leaks attacker signal
    // (e.g., bit-flip on a stored hash could otherwise expose a 500 with stack trace).
    try {
      const valid = await argon2.verify(storedHash, plain, ARGON2_OPTIONS);
      return { valid, needsRehash: false };
    } catch {
      return { valid: false, needsRehash: false };
    }
  }

  // Legacy bcrypt path — $2a$ or $2b$ prefix
  const valid = await bcrypt.compare(plain, storedHash);
  if (!valid) return { valid: false, needsRehash: false };
  return { valid: true, needsRehash: true };
}

import { eq, and, gt, isNull, desc, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { emailOtpCodes, reviewTokens } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";

/**
 * Persistence layer for the email_otp_codes lifecycle.
 *
 *   - createCode: insert a new row with hashed code + expires_at
 *   - getActiveCode: most-recent unverified, unexpired row for a token
 *   - incrementAttempts: atomic increment via SQL expression to avoid
 *     TOCTOU under concurrent /verify hits; returns new attempt count
 *   - markVerified: stamps verified_at on the active row
 *   - getMostRecentSendAt: latest created_at for resend cooldown (60s)
 *
 * Lockout state lives on review_tokens.otp_locked_until — see migration
 * 037. lockToken / readLock route through this module so the entire OTP
 * state machine has a single ownership surface.
 */

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
// Lock duration after MAX_ATTEMPTS wrong codes. 1 hour balances
// brute-force defense (10^6 keyspace, 5 attempts/hour ⇒ ~22M years
// expected to crack) against legitimate-recipient pain (someone who
// mistyped 5 times at 9pm should not be locked out until tomorrow).
// Aligned with NIST SP 800-63B Rev.4 §5.2.2 throttling guidance for
// out-of-band authenticators with short-TTL OTPs.
const LOCKOUT_DURATION_MS = 60 * 60 * 1000; // 1 hour
const MAX_ATTEMPTS = 5;

export interface CreatedOtpCode {
  id: string;
  expiresAt: Date;
}

export interface ActiveOtpCode {
  id: string;
  email: string;
  code_hash: string;
  expires_at: Date;
  attempts: number;
  created_at: Date;
}

export interface EmailOtpStore {
  createCode(input: { tokenId: string; email: string; codeHash: string }): Promise<CreatedOtpCode>;
  getActiveCode(tokenId: string): Promise<ActiveOtpCode | null>;
  incrementAttempts(codeId: string): Promise<number>;
  markVerified(codeId: string): Promise<void>;
  /** Most recent created_at across all rows for this token (resend cooldown). */
  getMostRecentSendAt(tokenId: string): Promise<Date | null>;
  /** Sets review_tokens.otp_locked_until = NOW() + 1h. */
  lockToken(tokenId: string): Promise<void>;
  /** Reads review_tokens.otp_locked_until. Null when never locked or lock expired. */
  readLock(tokenId: string): Promise<Date | null>;
}

export const OTP_CONSTANTS = {
  TTL_MS: OTP_TTL_MS,
  RESEND_COOLDOWN_MS,
  LOCKOUT_DURATION_MS,
  MAX_ATTEMPTS,
} as const;

function generateOtpRowId(): string {
  // 12 bytes = 24 hex chars; collision-resistant for the row count we
  // expect within a single 10-minute window. Mirrors the randomBytes
  // approach used by review-tokens.ts and ticket-store.ts.
  return `gw_otp_${randomBytes(12).toString("hex")}`;
}

export function createEmailOtpStore(db: AppDb): EmailOtpStore {
  return {
    async createCode({ tokenId, email, codeHash }) {
      const id = generateOtpRowId();
      const expiresAt = new Date(Date.now() + OTP_TTL_MS);
      await db.insert(emailOtpCodes).values({
        id,
        token_id: tokenId,
        email,
        code_hash: codeHash,
        expires_at: expiresAt,
      });
      return { id, expiresAt };
    },

    async getActiveCode(tokenId) {
      const [row] = await db
        .select()
        .from(emailOtpCodes)
        .where(
          and(
            eq(emailOtpCodes.token_id, tokenId),
            isNull(emailOtpCodes.verified_at),
            gt(emailOtpCodes.expires_at, new Date()),
          ),
        )
        .orderBy(desc(emailOtpCodes.created_at))
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        code_hash: row.code_hash,
        expires_at: row.expires_at,
        attempts: row.attempts,
        created_at: row.created_at,
      };
    },

    async incrementAttempts(codeId) {
      // Atomic increment at the DB level — under concurrent /verify
      // calls (e.g. retry storms) two reads of `attempts + 1` in
      // application code would race; the SQL expression collapses the
      // read+write into a single statement.
      const [updated] = await db
        .update(emailOtpCodes)
        .set({ attempts: sql`${emailOtpCodes.attempts} + 1` })
        .where(eq(emailOtpCodes.id, codeId))
        .returning({ attempts: emailOtpCodes.attempts });
      return updated?.attempts ?? 0;
    },

    async markVerified(codeId) {
      await db
        .update(emailOtpCodes)
        .set({ verified_at: new Date() })
        .where(eq(emailOtpCodes.id, codeId));
    },

    async getMostRecentSendAt(tokenId) {
      const [row] = await db
        .select({ created_at: emailOtpCodes.created_at })
        .from(emailOtpCodes)
        .where(eq(emailOtpCodes.token_id, tokenId))
        .orderBy(desc(emailOtpCodes.created_at))
        .limit(1);
      return row?.created_at ?? null;
    },

    async lockToken(tokenId) {
      await db
        .update(reviewTokens)
        .set({ otp_locked_until: new Date(Date.now() + LOCKOUT_DURATION_MS) })
        .where(eq(reviewTokens.id, tokenId));
    },

    async readLock(tokenId) {
      const [row] = await db
        .select({ otp_locked_until: reviewTokens.otp_locked_until })
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      const lock = row?.otp_locked_until;
      if (!lock) return null;
      if (lock.getTime() <= Date.now()) return null;
      return lock;
    },
  };
}

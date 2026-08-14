import { Router } from "express";
import { eq } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import { verifyPassword } from "../services/auth/password";
import QRCode from "qrcode";
import { reviewers } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import { InvalidRequestError, AuthenticationError } from "@gatewerk/shared";
import { sessionAuth } from "../middleware/session-auth";
import { serverEnv } from "../env";
import { NotImplementedError, RateLimitError } from "../lib/http-errors";
import {
  generateTotpSecret,
  encryptTotpSecret,
  decryptTotpSecret,
  verifyTotpCode,
  generateBackupCodes,
  hashBackupCodes,
  isTotpConfigured,
} from "../services/totp";

// The real audit service, not a hand-written subset. The local interface this
// replaces declared only `log()`, which made `logBestEffort` — the tier the
// contract requires a deliberate best-effort write to use — invisible to this
// file. app.ts has always passed the full service here.
import type { AuditService } from "../services/audit";

const isTest = serverEnv.NODE_ENV === "test" || serverEnv.VITEST === "true";

// Unlike /2fa/validate (login time), this endpoint sits behind sessionAuth —
// but a valid session is not proof of authenticator possession, so the
// 6-digit setup code it checks is still guessable without this: nothing else
// throttled repeated guesses against a pending enrolment.
const verifySetupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 1000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: new RateLimitError("Too many verification attempts. Try again in 15 minutes.").toJSON(),
});

export function createTwoFactorRoutes(db: AppDb, auditService: AuditService): Router {
  const router = Router();

  // POST /api/v1/auth/2fa/setup — generate TOTP secret + QR code
  router.post("/setup", sessionAuth(db), async (req, res, next) => {
    try {
      if (!isTotpConfigured()) {
        return next(
          new NotImplementedError(
            "2FA is not configured on this instance. Set TOTP_ENCRYPTION_KEY to enable.",
            "totp_not_configured",
          ),
        );
      }

      const reviewer = (req as any).reviewer;

      const [current] = await db
        .select({ totp_enabled_at: reviewers.totp_enabled_at })
        .from(reviewers)
        .where(eq(reviewers.id, reviewer.id))
        .limit(1);

      if (current?.totp_enabled_at) {
        throw new InvalidRequestError("2FA is already enabled", undefined, "2fa_already_enabled");
      }

      const { secret, uri, base32 } = generateTotpSecret(reviewer.email);
      const qrDataUrl = await QRCode.toDataURL(uri);

      await db
        .update(reviewers)
        .set({ totp_secret_encrypted: encryptTotpSecret(secret) })
        .where(eq(reviewers.id, reviewer.id));

      // Tier 2 REQUIRED (../services/AUDIT-WRITE-CONTRACT.md). This write plants
      // an encrypted TOTP secret on the account BEFORE any code has been
      // confirmed, and it overwrites whatever secret was there. `auth.2fa_setup`
      // fires only on verify-setup, so an enrolment that was started and never
      // confirmed — including one started by someone holding a stolen session —
      // left a live secret on the account with nothing recording that it had
      // been placed. Tier 2 rather than best-effort because there is no column
      // recording WHEN the secret was written: totp_secret_encrypted holds a
      // value with no timestamp, so this row is the only evidence.
      //
      // The secret, its plaintext, its base32 form and the otpauth URI are all
      // credentials and none of them appear here.
      await auditService.log({
        action: "auth.2fa_setup_started",
        actor: reviewer.id,
        resource_type: "reviewer",
        resource_id: reviewer.id,
        details: { ip: req.ip, user_agent: req.headers["user-agent"] ?? null },
      });

      res.json({ uri, base32, qr_data_url: qrDataUrl });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/2fa/verify-setup — confirm 2FA with code from authenticator
  router.post("/verify-setup", verifySetupLimiter, sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const { code } = req.body ?? {};

      if (!code || typeof code !== "string") {
        throw new InvalidRequestError("Code is required", "code", "missing_code");
      }

      const [current] = await db
        .select({
          totp_secret_encrypted: reviewers.totp_secret_encrypted,
          totp_enabled_at: reviewers.totp_enabled_at,
        })
        .from(reviewers)
        .where(eq(reviewers.id, reviewer.id))
        .limit(1);

      if (!current?.totp_secret_encrypted) {
        throw new InvalidRequestError("2FA setup not started", undefined, "2fa_not_started");
      }

      if (current.totp_enabled_at) {
        throw new InvalidRequestError("2FA is already enabled", undefined, "2fa_already_enabled");
      }

      const secret = decryptTotpSecret(current.totp_secret_encrypted);
      const valid = verifyTotpCode(secret, code.trim());
      if (!valid) {
        throw new InvalidRequestError("Invalid verification code", "code", "invalid_2fa_code");
      }

      const plaintextCodes = generateBackupCodes();
      const hashedCodes = await hashBackupCodes(plaintextCodes);

      await db
        .update(reviewers)
        .set({
          totp_enabled_at: new Date(),
          totp_backup_codes: JSON.stringify(hashedCodes),
        })
        .where(eq(reviewers.id, reviewer.id));

      // Tier 3 BEST_EFFORT. Converted from `.catch(() => {})`, which swallowed
      // the failure and made a deliberate choice indistinguishable from an
      // oversight. The argument is specific to this handler: the response below
      // carries the ONLY copy of the plaintext backup codes, which have already
      // been hashed into the reviewers row. Failing the request after that write
      // would destroy the user's sole recovery path for a 2FA enrolment that is
      // now live. `totp_enabled_at` independently records that 2FA is on.
      auditService.logBestEffort(
        {
          action: "auth.2fa_setup",
          actor: reviewer.id,
          resource_type: "reviewer",
          resource_id: reviewer.id,
          details: { ip: req.ip },
        },
        "the response carries the only copy of the backup codes, and totp_enabled_at durably records the enrolment",
      );

      res.json({ backup_codes: plaintextCodes });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/v1/auth/2fa — disable 2FA (requires current password)
  router.delete("/", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const { current_password } = req.body ?? {};

      if (typeof current_password !== "string" || !current_password) {
        throw new InvalidRequestError("Current password required", "current_password", "missing_password");
      }

      const [full] = await db
        .select()
        .from(reviewers)
        .where(eq(reviewers.id, reviewer.id))
        .limit(1);

      const { valid: passwordValid } = await verifyPassword(full.password_hash, current_password);
      if (!passwordValid) {
        throw new AuthenticationError("Invalid password", "invalid_password");
      }

      await db
        .update(reviewers)
        .set({
          totp_secret_encrypted: null,
          totp_enabled_at: null,
          totp_backup_codes: null,
          last_used_totp_at: null,
        })
        .where(eq(reviewers.id, reviewer.id));

      // Tier 3 BEST_EFFORT. Converted from `.catch(() => {})`. This is the
      // weakest of the three arguments and worth stating plainly: the write above
      // nulls totp_enabled_at, so once it runs NOTHING in the schema records that
      // 2FA was ever on or when it came off — by the contract's own test this
      // looks like a Tier 2 site. It stays best-effort because the failure mode
      // on the other side is worse: a reviewer who has lost their authenticator
      // and cannot disable 2FA because audit_log is unavailable is locked out of
      // their own account by the logging subsystem, and OSS has no reset flow to
      // recover from that. Current password is already required here, so the act
      // is authenticated. Revisit if 2FA disablement ever gains its own column.
      auditService.logBestEffort(
        {
          action: "auth.2fa_disabled",
          actor: reviewer.id,
          resource_type: "reviewer",
          resource_id: reviewer.id,
          details: { ip: req.ip },
        },
        "an audit outage must not lock a reviewer out of their own account when they cannot disable 2FA",
      );

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/2fa/backup-codes — regenerate backup codes
  router.post("/backup-codes", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const { current_password } = req.body ?? {};

      if (typeof current_password !== "string" || !current_password) {
        throw new InvalidRequestError("Current password required", "current_password", "missing_password");
      }

      const [full] = await db
        .select()
        .from(reviewers)
        .where(eq(reviewers.id, reviewer.id))
        .limit(1);

      if (!full.totp_enabled_at) {
        throw new InvalidRequestError("2FA is not enabled", undefined, "2fa_not_enabled");
      }

      const { valid: passwordValid } = await verifyPassword(full.password_hash, current_password);
      if (!passwordValid) {
        throw new AuthenticationError("Invalid password", "invalid_password");
      }

      const plaintextCodes = generateBackupCodes();
      const hashedCodes = await hashBackupCodes(plaintextCodes);

      await db
        .update(reviewers)
        .set({ totp_backup_codes: JSON.stringify(hashedCodes) })
        .where(eq(reviewers.id, reviewer.id));

      // Tier 3 BEST_EFFORT. Converted from `.catch(() => {})`. Same argument as
      // verify-setup: the hashed codes are already written and the response below
      // is the only place the plaintext exists, so failing the request would
      // leave the account with recovery codes nobody can read.
      auditService.logBestEffort(
        {
          action: "auth.2fa_backup_regenerated",
          actor: reviewer.id,
          resource_type: "reviewer",
          resource_id: reviewer.id,
          details: { ip: req.ip },
        },
        "the response carries the only copy of the regenerated backup codes, which are already persisted as hashes",
      );

      res.json({ backup_codes: plaintextCodes });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

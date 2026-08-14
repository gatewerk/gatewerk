import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "../services/auth/password";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { reviewers } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import type { AuditAction } from "@gatewerk/shared";
import {
  InvalidRequestError,
  AuthenticationError,
} from "@gatewerk/shared";
import { config } from "../config";
import { serverEnv } from "../env";
import { sessionAuth } from "../middleware/session-auth";
import { RateLimitError } from "../lib/http-errors";
import type { EmailService } from "../services/email";
import { createSessionService } from "../services/sessions";
import { validatePassword } from "../lib/password-policy";
import { notifyNewIpLogin } from "../lib/login-notifications";

interface AuditService {
  log(data: {
    action: AuditAction;
    actor: string;
    resource_type: string;
    resource_id?: string;
    details?: Record<string, unknown>;
    project_id?: string;
  }): Promise<any>;
}

const isTest = serverEnv.NODE_ENV === "test" || serverEnv.VITEST === "true";

/**
 * Open-redirect allowlist for the optional `return_to` parameter on POST
 * /login. Strict allowlist — only relative paths under `/r/` are accepted
 * because the recipient surface is the only legitimate post-login target
 * for an account-bound link. OWASP A01:2021 (Broken Access Control)
 * §"Unvalidated redirects and forwards" forbids reflective redirects that
 * accept arbitrary URLs because the attacker can wrap the login URL with
 * a malicious return target and use it for phishing.
 *
 * RFC 3986 §3.1 (URI scheme syntax) and §4.2 (relative reference and
 * protocol-relative URIs) anchor the deny patterns: any value beginning
 * with `scheme:` or `//` resolves as an absolute URL, not a same-origin
 * relative path, and would let an attacker redirect to an external host.
 */
const RETURN_TO_PREFIX = "/r/";
/**
 * The second allowed target. `your-turn.tsx` links a notified reviewer at
 * `/reviews/<id>`; without this, a signed out reviewer lost the review at
 * the login screen — RequireAuth threw the destination away and they landed
 * on the inbox. This is the deep link the phone layout depends on.
 *
 * Anchored at both ends and character classed, so the id may only be url safe
 * id characters and there is no second path segment to walk out of /reviews/
 * with. The deny substrings and the scheme test below still apply on top.
 * This stays a two entry allowlist; do not add a third without the same care.
 */
const RETURN_TO_REVIEW_PATTERN = /^\/reviews\/[A-Za-z0-9_-]+$/;
const RETURN_TO_DENY_SUBSTRINGS = ["..", "//", "\\"];
const RETURN_TO_SCHEME_PATTERN = /^[a-z][a-z0-9+\-.]*:/i;

function validateReturnTo(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const allowed =
    value.startsWith(RETURN_TO_PREFIX) || RETURN_TO_REVIEW_PATTERN.test(value);
  if (!allowed) return null;
  for (const denied of RETURN_TO_DENY_SUBSTRINGS) {
    if (value.includes(denied)) return null;
  }
  if (RETURN_TO_SCHEME_PATTERN.test(value)) return null;
  return value;
}

function getLockDuration(failedCount: number): number | null {
  if (failedCount >= 20) return 24 * 60 * 60 * 1000;
  if (failedCount >= 10) return 60 * 60 * 1000;
  if (failedCount >= 5) return 15 * 60 * 1000;
  return null;
}

function formatLockMinutes(ms: number): string {
  const mins = Math.ceil(ms / 60000);
  if (mins >= 1440) return "24 hours";
  if (mins >= 60) return `${Math.ceil(mins / 60)} hour${Math.ceil(mins / 60) > 1 ? "s" : ""}`;
  return `${mins} minutes`;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTest ? 1000 : 10, // relaxed in test, 10 attempts per window in production
  standardHeaders: true,
  legacyHeaders: false,
  message: new RateLimitError("Too many login attempts. Try again in 15 minutes.").toJSON(),
});

const tfaValidateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 1000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: new RateLimitError("Too many 2FA attempts. Try again in 15 minutes.").toJSON(),
});

export function createAuthRoutes(db: AppDb, auditService: AuditService, emailService: EmailService): Router {
  const router = Router();
  const sessionService = createSessionService(db);

  // In-process login ticket store (5 min TTL, single-use)
  const loginTickets = new Map<string, { reviewerId: string; createdAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of loginTickets) {
      if (now - val.createdAt > 5 * 60 * 1000) loginTickets.delete(key);
    }
  }, 60 * 1000);

  // POST /api/v1/auth/login — authenticate reviewer
  router.post("/login", loginLimiter, async (req, res, next) => {
    try {
      const { email, password, return_to } = req.body ?? {};

      if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
        throw new InvalidRequestError("Missing required fields: email, password", undefined, "missing_credentials");
      }

      // Validate the optional return_to BEFORE the password check so an
      // attacker probing for valid emails cannot use the redirect-rejection
      // 400 as an oracle. Order also matters because authentication
      // failure must short-circuit ahead of any client navigation hint.
      let validatedReturnTo: string | null = null;
      if (return_to !== undefined && return_to !== null) {
        validatedReturnTo = validateReturnTo(return_to);
        if (!validatedReturnTo) {
          throw new InvalidRequestError(
            "Invalid return_to URL.",
            "return_to",
            "invalid_return_to",
          );
        }
      }

      const [reviewer] = await db
        .select()
        .from(reviewers)
        .where(eq(reviewers.email, email))
        .limit(1);

      // Treat all auth failures uniformly to prevent email enumeration:
      // unknown user, deactivated user, and bad password all return the same
      // "Invalid email or password" message and code.
      if (!reviewer || !reviewer.is_active) {
        throw new AuthenticationError("Invalid email or password", "invalid_credentials");
      }

      // Account lockout check
      if (reviewer.locked_until) {
        const lockedUntil = new Date(reviewer.locked_until);
        if (lockedUntil > new Date()) {
          const retryAfterSeconds = Math.ceil((lockedUntil.getTime() - Date.now()) / 1000);
          res.set("Retry-After", String(retryAfterSeconds));
          res.status(429).json(
            new RateLimitError(
              `Too many failed login attempts. Try again in ${formatLockMinutes(retryAfterSeconds * 1000)}.`,
              "account_locked",
            ).toJSON(),
          );
          return;
        }
        // Lock expired — reset counters before re-evaluating credentials so a
        // single subsequent failure can't immediately re-trip the threshold.
        await db.update(reviewers)
          .set({ failed_login_count: 0, locked_until: null })
          .where(eq(reviewers.id, reviewer.id));
        reviewer.failed_login_count = 0;
        reviewer.locked_until = null;
      }

      const { valid, needsRehash } = await verifyPassword(reviewer.password_hash, password);
      if (!valid) {
        const newCount = (reviewer.failed_login_count ?? 0) + 1;
        const lockDuration = getLockDuration(newCount);
        const updates: Record<string, any> = {
          failed_login_count: newCount,
        };
        if (lockDuration) {
          updates.locked_until = new Date(Date.now() + lockDuration);
          auditService.log({
            action: "auth.lockout",
            actor: reviewer.id,
            resource_type: "reviewer",
            resource_id: reviewer.id,
            details: {
              failed_count: newCount,
              locked_until: updates.locked_until.toISOString(),
              lock_duration_ms: lockDuration,
              ip: req.ip,
            },
          }).catch(() => {});
        }
        await db.update(reviewers)
          .set(updates)
          .where(eq(reviewers.id, reviewer.id));

        auditService.log({
          action: "auth.login_failure",
          actor: reviewer.id,
          resource_type: "reviewer",
          resource_id: reviewer.id,
          details: { ip: req.ip, user_agent: req.headers["user-agent"], reason: "invalid_password", failed_count: newCount },
        }).catch(() => {});

        throw new AuthenticationError("Invalid email or password", "invalid_credentials");
      }

      // Reset lockout counter + update last_login_at
      db.update(reviewers)
        .set({
          last_login_at: new Date(),
          failed_login_count: 0,
          locked_until: null,
        })
        .where(eq(reviewers.id, reviewer.id))
        .catch(() => {});

      // Transparent argon2id upgrade: if the stored hash is legacy bcrypt and
      // password is correct, silently replace the hash. Fire-and-forget so
      // login latency is unaffected. Failure of the rehash does not fail login.
      if (needsRehash) {
        // Fire-and-forget rehash with explicit failure surfacing.
        // Outer catch: argon2.hash failed (e.g., native binding panic) — log to ops.
        // Inner catch: DB update failed — log to ops AND emit `password.rehash_failed`
        // audit so the operator sees per-user drift in the same surface they monitor
        // for /password-hash-stats migration progress.
        hashPassword(password)
          .then(async (newHash) => {
            try {
              await db.update(reviewers).set({ password_hash: newHash }).where(eq(reviewers.id, reviewer.id));
            } catch (err) {
              console.error("password_rehash_db_update_failed", { reviewer_id: reviewer.id, err });
              auditService.log({
                action: "password.rehash_failed",
                actor: reviewer.id,
                resource_type: "reviewer",
                resource_id: reviewer.id,
                details: { stage: "db_update", reason: err instanceof Error ? err.message : String(err) },
              }).catch((auditErr) =>
                console.error("password_rehash_audit_failed_after_db_failure", { reviewer_id: reviewer.id, auditErr }),
              );
            }
          })
          .catch((err) => console.error("password_rehash_hash_failed", { reviewer_id: reviewer.id, err }));

        auditService.log({
          action: "password.rehashed",
          actor: reviewer.id,
          resource_type: "reviewer",
          resource_id: reviewer.id,
          details: { reason: "bcrypt_to_argon2id_upgrade" },
        }).catch((err) =>
          console.error("password_rehash_audit_emission_failed", { reviewer_id: reviewer.id, err }),
        );
      }

      // 2FA gate: if TOTP is enabled, issue a login ticket instead of a JWT
      if (reviewer.totp_enabled_at) {
        const ticket = crypto.randomBytes(32).toString("hex");
        loginTickets.set(ticket, { reviewerId: reviewer.id, createdAt: Date.now() });
        res.json({ requires_2fa: true, login_ticket: ticket });
        return;
      }

      // Create server-side session
      const { jti, sessionId } = await sessionService.create({
        reviewerId: reviewer.id,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] as string | undefined,
      });

      const token = jwt.sign(
        {
          sub: reviewer.id,
          email: reviewer.email,
          role: reviewer.role,
          tokenVersion: reviewer.token_version ?? 0,
          jti,
        },
        config.jwtSecret,
        { expiresIn: "7d", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
      );

      // Audit login success (fire-and-forget)
      auditService.log({
        action: "auth.login_success",
        actor: reviewer.id,
        resource_type: "session",
        resource_id: sessionId,
        details: { ip: req.ip, user_agent: req.headers["user-agent"] },
      }).catch(() => {});
      notifyNewIpLogin(db, emailService, reviewer, req.ip, req.headers["user-agent"] as string | undefined).catch(() => {});

      const responseBody: Record<string, unknown> = {
        token,
        reviewer: {
          id: reviewer.id,
          email: reviewer.email,
          name: reviewer.name,
          role: reviewer.role,
        },
        must_change_password: reviewer.must_change_password ?? false,
      };
      if (validatedReturnTo) {
        responseBody.return_to = validatedReturnTo;
      }
      res.json(responseBody);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/auth/me — get current reviewer info
  router.get("/me", sessionAuth(db), async (req, res, next) => {
    try {
      const sessionReviewer = (req as any).reviewer;
      const [reviewer] = await db
        .select()
        .from(reviewers)
        .where(eq(reviewers.id, sessionReviewer.id))
        .limit(1);

      res.json({
        id: reviewer.id,
        email: reviewer.email,
        name: reviewer.name,
        role: reviewer.role,
        last_login_at: reviewer.last_login_at,
        created_at: reviewer.created_at,
        must_change_password: reviewer.must_change_password ?? false,
        has_2fa: !!reviewer.totp_enabled_at,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/change-password — forced first-login change OR
  // voluntary change that must present `current_password`.
  //
  // Without a current_password gate, a stolen-JWT holder could set a password
  // of their choosing AND bump token_version — invalidating the victim's other
  // sessions while keeping a credential the attacker knows. Gatewerk OSS has
  // no password-reset flow, so that lockout is permanent without DB surgery.
  //
  // The forced first-login path intentionally bypasses current_password
  // because admin-seeded accounts boot with `must_change_password = true` and
  // a random password the user never sees.
  router.post("/change-password", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const { new_password, current_password } = req.body;

      if (!new_password || typeof new_password !== "string") {
        throw new InvalidRequestError("Password is required", "new_password", "password_required");
      }

      const [fullReviewer] = await db
        .select()
        .from(reviewers)
        .where(eq(reviewers.id, reviewer.id))
        .limit(1);

      if (!fullReviewer) {
        throw new AuthenticationError("Session reviewer not found", "invalid_credentials");
      }

      // Only the forced first-login flow skips current_password verification.
      if (!fullReviewer.must_change_password) {
        if (!current_password || typeof current_password !== "string") {
          throw new InvalidRequestError(
            "current_password is required to change password",
            "current_password",
            "missing_current_password",
          );
        }
        const { valid } = await verifyPassword(fullReviewer.password_hash, current_password);
        if (!valid) {
          throw new InvalidRequestError(
            "Current password is incorrect",
            "current_password",
            "incorrect_password",
          );
        }
      }

      const policyResult = await validatePassword(new_password);
      if (!policyResult.valid) {
        throw new InvalidRequestError(
          policyResult.message ?? "Password does not meet policy requirements",
          "new_password",
          policyResult.code ?? "password_policy",
        );
      }

      const password_hash = await hashPassword(new_password);

      const [updated] = await db
        .update(reviewers)
        .set({
          password_hash,
          must_change_password: false,
          token_version: sql`COALESCE(token_version, 0) + 1`,
          updated_at: new Date(),
        })
        .where(eq(reviewers.id, reviewer.id))
        .returning();

      // Tier 2 REQUIRED (../services/AUDIT-WRITE-CONTRACT.md). Deliberately
      // `auth.password_changed`, not `auth.password_reset`: a reset is an
      // out-of-band recovery flow, this is an authenticated credential rotation,
      // and spelling them the same would make an account takeover read as a
      // forgotten password. The reviewers row keeps only the new hash, so this is
      // the sole record that the credential changed, and — because the write
      // below bumps token_version and revokes every session — the sole
      // attribution for that mass revocation too.
      //
      // `forced` distinguishes the admin-seeded first-login path, which skips
      // current_password verification, from a voluntary change that proved it.
      // No hash, old or new, ever appears here.
      await auditService.log({
        action: "auth.password_changed",
        actor: reviewer.id,
        resource_type: "reviewer",
        resource_id: reviewer.id,
        details: {
          via: "change_password",
          forced: fullReviewer.must_change_password === true,
          token_version: updated.token_version ?? 0,
          ip: req.ip,
          user_agent: req.headers["user-agent"] ?? null,
        },
      });

      // Revoke all existing sessions
      await sessionService.revokeAll(reviewer.id);

      // Create a new session for the fresh token
      const { jti: newJti } = await sessionService.create({
        reviewerId: updated.id,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] as string | undefined,
      });

      const token = jwt.sign(
        {
          sub: updated.id,
          email: updated.email,
          role: updated.role,
          tokenVersion: updated.token_version ?? 0,
          jti: newJti,
        },
        config.jwtSecret,
        { expiresIn: "7d", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
      );

      res.json({
        token,
        reviewer: {
          id: updated.id,
          email: updated.email,
          name: updated.name,
          role: updated.role,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/v1/auth/profile — update current reviewer's profile
  router.put("/profile", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const { name, current_password, new_password } = req.body;

      const updates: Record<string, any> = { updated_at: new Date() };

      // Handle name update
      if (name !== undefined) {
        if (typeof name !== "string" || name.trim() === "") {
          throw new InvalidRequestError("Name must be a non-empty string", "name", "invalid_name");
        }
        updates.name = name.trim();
      }

      // Handle password change
      if (new_password !== undefined) {
        if (typeof current_password !== "string" || !current_password) {
          throw new InvalidRequestError(
            "current_password is required to change password",
            "current_password",
            "missing_current_password",
          );
        }

        // Look up the full reviewer record to get password_hash
        const [fullReviewer] = await db
          .select()
          .from(reviewers)
          .where(eq(reviewers.id, reviewer.id))
          .limit(1);

        const { valid } = await verifyPassword(fullReviewer.password_hash, current_password);
        if (!valid) {
          throw new InvalidRequestError("Current password is incorrect", "current_password", "incorrect_password");
        }

        if (typeof new_password !== "string") {
          throw new InvalidRequestError("Password is required", "new_password", "password_required");
        }
        const profPolicyResult = await validatePassword(new_password);
        if (!profPolicyResult.valid) {
          throw new InvalidRequestError(
            profPolicyResult.message ?? "Password does not meet policy requirements",
            "new_password",
            profPolicyResult.code ?? "password_policy",
          );
        }

        updates.password_hash = await hashPassword(new_password);
        updates.token_version = sql`COALESCE(token_version, 0) + 1`;
      }

      // Apply updates
      const [updated] = await db
        .update(reviewers)
        .set(updates)
        .where(eq(reviewers.id, reviewer.id))
        .returning();

      // Tier 2 REQUIRED. Two distinct events can come out of one request, and
      // they are kept separate rather than folded into one `profile.updated`:
      // a display-name edit and a credential rotation are not the same act, and
      // an auditor filtering for credential changes must not have to know that
      // some of them hide inside a profile update.
      //
      // Name matters because it is the string every review and audit row renders
      // its actor as, so a rename quietly changes how existing history reads.
      // Both values are recorded so the rename is reversible from the ledger.
      if (updates.name !== undefined) {
        await auditService.log({
          action: "profile.updated",
          actor: reviewer.id,
          resource_type: "reviewer",
          resource_id: reviewer.id,
          details: {
            field: "name",
            name_from: reviewer.name ?? null,
            name_to: updated.name,
            ip: req.ip,
          },
        });
      }

      if (new_password !== undefined) {
        // Same action as POST /change-password — one spelling for "this
        // account's password changed", regardless of which endpoint did it, so a
        // ledger query for credential rotations cannot miss this path. `via`
        // preserves which route was used. No hash is ever recorded.
        await auditService.log({
          action: "auth.password_changed",
          actor: reviewer.id,
          resource_type: "reviewer",
          resource_id: reviewer.id,
          details: {
            via: "profile",
            forced: false,
            token_version: updated.token_version ?? 0,
            ip: req.ip,
            user_agent: req.headers["user-agent"] ?? null,
          },
        });
      }

      // If password was changed, return a fresh token so current session stays valid
      const response: Record<string, any> = {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role,
        last_login_at: updated.last_login_at,
        created_at: updated.created_at,
      };

      if (new_password !== undefined) {
        // Revoke all sessions, create new one
        await sessionService.revokeAll(reviewer.id);
        const { jti: profJti } = await sessionService.create({
          reviewerId: updated.id,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] as string | undefined,
        });
        response.token = jwt.sign(
          { sub: updated.id, email: updated.email, role: updated.role, tokenVersion: updated.token_version ?? 0, jti: profJti },
          config.jwtSecret,
          { expiresIn: "7d", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
        );
      }

      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/2fa/validate — complete login with TOTP code
  router.post("/2fa/validate", tfaValidateLimiter, async (req, res, next) => {
    try {
      const { login_ticket, code } = req.body ?? {};

      if (typeof login_ticket !== "string" || typeof code !== "string" || !login_ticket || !code) {
        throw new InvalidRequestError("login_ticket and code are required", undefined, "missing_fields");
      }

      const ticketData = loginTickets.get(login_ticket);
      if (!ticketData) {
        throw new AuthenticationError("Invalid or expired login ticket", "invalid_ticket");
      }

      if (Date.now() - ticketData.createdAt > 5 * 60 * 1000) {
        loginTickets.delete(login_ticket);
        throw new AuthenticationError("Login ticket expired", "ticket_expired");
      }

      loginTickets.delete(login_ticket);

      const [reviewer] = await db
        .select()
        .from(reviewers)
        .where(eq(reviewers.id, ticketData.reviewerId))
        .limit(1);

      if (!reviewer || !reviewer.is_active || !reviewer.totp_enabled_at) {
        throw new AuthenticationError("Invalid login state", "invalid_state");
      }

      const { decryptTotpSecret, verifyTotpCodeWithStep, verifyBackupCode } = await import("../services/totp");
      const secret = decryptTotpSecret(reviewer.totp_secret_encrypted!);
      let method: "totp" | "backup_code" = "totp";
      const totpResult = verifyTotpCodeWithStep(secret, code.trim());
      // Reject a code whose time-step was already consumed — otherwise the
      // same 6 digits stay valid (replayable) for up to ~90s after first use.
      let codeValid =
        totpResult.valid &&
        (!reviewer.last_used_totp_at || totpResult.stepStartedAt! > reviewer.last_used_totp_at);

      if (!codeValid && reviewer.totp_backup_codes) {
        const rawCodes = reviewer.totp_backup_codes;
        const storedCodes = typeof rawCodes === "string" ? JSON.parse(rawCodes) : rawCodes;
        const backupResult = await verifyBackupCode(code.trim(), storedCodes);
        if (backupResult.valid) {
          codeValid = true;
          method = "backup_code";
          storedCodes[backupResult.index].used_at = new Date().toISOString();
          await db
            .update(reviewers)
            .set({ totp_backup_codes: JSON.stringify(storedCodes) })
            .where(eq(reviewers.id, reviewer.id));
        }
      }

      if (!codeValid) {
        throw new AuthenticationError("Invalid verification code", "invalid_2fa_code");
      }

      if (method === "totp") {
        db.update(reviewers)
          .set({ last_used_totp_at: totpResult.stepStartedAt! })
          .where(eq(reviewers.id, reviewer.id))
          .catch(() => {});
      }

      // Reset lockout + update last_login_at
      db.update(reviewers)
        .set({ last_login_at: new Date(), failed_login_count: 0, locked_until: null })
        .where(eq(reviewers.id, reviewer.id))
        .catch(() => {});

      const { jti, sessionId } = await sessionService.create({
        reviewerId: reviewer.id,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] as string | undefined,
      });

      const token = jwt.sign(
        {
          sub: reviewer.id,
          email: reviewer.email,
          role: reviewer.role,
          tokenVersion: reviewer.token_version ?? 0,
          jti,
        },
        config.jwtSecret,
        { expiresIn: "7d", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
      );

      auditService.log({
        action: "auth.2fa_validated",
        actor: reviewer.id,
        resource_type: "session",
        resource_id: sessionId,
        details: { ip: req.ip, method },
      }).catch(() => {});

      auditService.log({
        action: "auth.login_success",
        actor: reviewer.id,
        resource_type: "session",
        resource_id: sessionId,
        details: { ip: req.ip, user_agent: req.headers["user-agent"], has_2fa: true },
      }).catch(() => {});
      notifyNewIpLogin(db, emailService, reviewer, req.ip, req.headers["user-agent"] as string | undefined).catch(() => {});

      res.json({
        token,
        reviewer: {
          id: reviewer.id,
          email: reviewer.email,
          name: reviewer.name,
          role: reviewer.role,
        },
        must_change_password: reviewer.must_change_password ?? false,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

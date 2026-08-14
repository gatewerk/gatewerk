import { Router } from "express";
import { eq, sql, and, gt, like } from "drizzle-orm";
import { hashPassword, verifyPassword } from "../services/auth/password";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { reviewers, auditLog, notificationPreferences, notifications, slackUserLinks, productFeedback } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import type { AuditAction } from "@gatewerk/shared";
import { InvalidRequestError, AuthenticationError, NotFoundError, DEFAULT_NOTIFICATION_PREFS, NotificationPrefsSchema } from "@gatewerk/shared";
import { ValidationError } from "../middleware/validate";
import { serverEnv } from "../env";
import { config } from "../config";
import { sessionAuth } from "../middleware/session-auth";
import { createSessionService } from "../services/sessions";
import { validatePassword } from "../lib/password-policy";
import { generateEmailToken, verifyEmailToken } from "../lib/email-tokens";
import { constantTimeEqual } from "../lib/crypto";
import { anonymizeAuditLogForReviewer } from "../lib/audit-anonymize";
import {
  assertDeletionCredential,
  resolveDeletionChallenge,
  loadCloudDeletion,
} from "../lib/account-deletion";
import type { EmailService } from "../services/email";
import { renderEmail, EmailVerifyEmail, PasswordResetEmail } from "@gatewerk/emails";

interface AuditService {
  log(data: {
    action: AuditAction;
    actor: string;
    resource_type: string;
    resource_id?: string;
    details?: Record<string, unknown>;
  }): Promise<any>;
}

const isTest = serverEnv.NODE_ENV === "test" || serverEnv.VITEST === "true";

// ── Avatar ────────────────────────────────────────────────────────────────

/** Raw bytes only, matching what services/media.ts already excludes for the
 *  same reason: an SVG can carry a <script>, so it never qualifies as an
 *  image upload regardless of what a client claims its content-type is. */
const ALLOWED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Client resizes to a small square before upload; this is a hard ceiling
 *  against a client that doesn't, not the expected size. 512KB raw is
 *  already generous — a 256px avatar at good quality is tens of KB. */
const MAX_AVATAR_BYTES = 512 * 1024;

/**
 * Confirms the buffer's own magic bytes match one of ALLOWED_AVATAR_TYPES,
 * independent of whatever content-type the client's data: URL declared.
 * A declared type is just a claim; this is what actually decides what gets
 * served back to a browser with that Content-Type header.
 */
function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 1000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "TooManyRequests",
    message: "Too many password reset requests. Try again in 15 minutes.",
    status: 429,
  },
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 1000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "TooManyRequests",
    message: "Too many password reset attempts. Try again in 15 minutes.",
    status: 429,
  },
});

const resendVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 1000 : 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "TooManyRequests",
    message: "Too many verification requests. Try again in 15 minutes.",
    status: 429,
  },
});

export function createAccountRoutes(
  db: AppDb,
  auditService: AuditService,
  emailService: EmailService,
): Router {
  const router = Router();
  const sessionService = createSessionService(db);

  // POST /verify-email — consume a verify-email token, mark email verified
  router.post("/verify-email", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const { token } = req.body ?? {};

      if (!token || typeof token !== "string") {
        throw new InvalidRequestError("token is required", "token", "missing_token");
      }

      const payload = verifyEmailToken(token, "verify-email");
      if (!payload || payload.reviewer_id !== reviewer.id) {
        throw new InvalidRequestError("Invalid or expired verification token", "token", "invalid_token");
      }

      await db
        .update(reviewers)
        .set({ email_verified_at: new Date() })
        .where(eq(reviewers.id, reviewer.id));

      auditService.log({
        action: "auth.email_verified",
        actor: reviewer.id,
        resource_type: "reviewer",
        resource_id: reviewer.id,
        details: { email: reviewer.email },
      }).catch(() => {});

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /resend-verification — generate and email a new verification link
  router.post("/resend-verification", resendVerificationLimiter, sessionAuth(db), async (req, res, next) => {
    try {
      const sessionReviewer = (req as any).reviewer;

      const [reviewer] = await db
        .select()
        .from(reviewers)
        .where(eq(reviewers.id, sessionReviewer.id))
        .limit(1);

      if (!reviewer) {
        throw new AuthenticationError("Reviewer not found", "invalid_credentials");
      }

      if (reviewer.email_verified_at) {
        res.json({ ok: true });
        return;
      }

      const token = generateEmailToken(
        { reviewer_id: reviewer.id, email: reviewer.email, purpose: "verify-email" },
        24 * 60 * 60 * 1000,
      );

      const link = `${config.uiOrigin}/verify-email?token=${token}`;

      // Deliberately does NOT pass organization_id to sendEmail below. Doing
      // so would opt this send into the per-tenant deliverability breaker
      // (Stage 5a, apps/api/src/services/email/index.ts), which can
      // silently drop mail for a paused tenant. Account mail must keep
      // reaching a user whose organization is paused, since blocking it
      // would lock them out of the product entirely, a worse outcome than
      // the bounces the breaker exists to prevent. See
      // notification-email-handler.ts / notification-digest-handler.ts for
      // the mail that IS meant to opt in.
      renderEmail(EmailVerifyEmail, { verifyUrl: link, logoUrl: config.emailLogoUrl })
        .then((rendered) => emailService.sendEmail({ to: reviewer.email, ...rendered }))
        .catch((err) => {
          // Non-blocking: the response already returned ok. Log so a
          // render/send failure is observable instead of swallowed silently.
          console.warn("[account] verify-email render/send failed", {
            errorId: "ACCOUNT_VERIFY_EMAIL_FAILED",
            error: err,
          });
        });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /forgot-password — PUBLIC. Sends reset link, always returns ok.
  router.post("/forgot-password", forgotPasswordLimiter, async (req, res, next) => {
    try {
      const { email } = req.body ?? {};

      if (!email || typeof email !== "string") {
        // Still return ok — no enumeration
        res.json({ ok: true });
        return;
      }

      const [reviewer] = await db
        .select()
        .from(reviewers)
        .where(eq(reviewers.email, email.toLowerCase().trim()))
        .limit(1);

      if (reviewer && reviewer.is_active) {
        const rawToken = crypto.randomBytes(32).toString("hex");
        const hashedToken = crypto
          .createHash("sha256")
          .update(rawToken)
          .digest("hex");

        await db
          .update(reviewers)
          .set({
            password_reset_token_hash: hashedToken,
            password_reset_expires_at: new Date(Date.now() + 60 * 60 * 1000),
          })
          .where(eq(reviewers.id, reviewer.id));

        const link = `${config.uiOrigin}/reset-password?token=${rawToken}`;

        // Deliberately does NOT pass organization_id to sendEmail below. Doing
        // so would opt this send into the per-tenant deliverability breaker
        // (Stage 5a, apps/api/src/services/email/index.ts), which can
        // silently drop mail for a paused tenant. A password reset must keep
        // reaching a user whose organization is paused, since blocking it
        // would lock them out of the product entirely, a worse outcome than
        // the bounces the breaker exists to prevent. See
        // notification-email-handler.ts / notification-digest-handler.ts for
        // the mail that IS meant to opt in.
        renderEmail(PasswordResetEmail, { resetUrl: link, logoUrl: config.emailLogoUrl })
          .then((rendered) => emailService.sendEmail({ to: reviewer.email, ...rendered }))
          .catch((err) => {
            // Stays non-blocking so /forgot-password always returns ok before
            // render completes (no account enumeration). Server-side log only
            // — never surfaced in the response.
            console.warn("[account] password-reset render/send failed", {
              errorId: "ACCOUNT_PASSWORD_RESET_EMAIL_FAILED",
              error: err,
            });
          });

        auditService.log({
          action: "auth.password_reset_requested",
          actor: reviewer.id,
          resource_type: "reviewer",
          resource_id: reviewer.id,
          details: { email: reviewer.email },
        }).catch(() => {});
      }

      // Always return ok to prevent email enumeration
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /reset-password — PUBLIC. Validates reset token and sets new password.
  router.post("/reset-password", resetPasswordLimiter, async (req, res, next) => {
    try {
      const { token, new_password } = req.body ?? {};

      if (!token || typeof token !== "string") {
        throw new InvalidRequestError("token is required", "token", "missing_token");
      }
      if (!new_password || typeof new_password !== "string") {
        throw new InvalidRequestError("new_password is required", "new_password", "missing_password");
      }

      const hashedToken = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

      // O(1) lookup by hashed token
      const [reviewer] = await db
        .select()
        .from(reviewers)
        .where(eq(reviewers.password_reset_token_hash, hashedToken))
        .limit(1);

      if (!reviewer || !reviewer.password_reset_token_hash || !reviewer.password_reset_expires_at) {
        throw new InvalidRequestError("Invalid or expired reset token", "token", "invalid_token");
      }

      // Timing-safe compare (already done via query equality; double-check expiry).
      // B2's migration-completeness grep checked only the 2 declared-scope files;
      // this 3rd site was missed. Future migration sweeps should grep across
      // apps/api/src/{routes,services}/** not just the known-touched files.
      if (!constantTimeEqual(reviewer.password_reset_token_hash, hashedToken)) {
        throw new InvalidRequestError("Invalid or expired reset token", "token", "invalid_token");
      }

      if (new Date(reviewer.password_reset_expires_at) < new Date()) {
        throw new InvalidRequestError("Reset token has expired", "token", "token_expired");
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

      await db
        .update(reviewers)
        .set({
          password_hash,
          token_version: sql`COALESCE(token_version, 0) + 1`,
          password_reset_token_hash: null,
          password_reset_expires_at: null,
          updated_at: new Date(),
        })
        .where(eq(reviewers.id, reviewer.id));

      await sessionService.revokeAll(reviewer.id);

      auditService.log({
        action: "auth.password_reset",
        actor: reviewer.id,
        resource_type: "reviewer",
        resource_id: reviewer.id,
        details: { email: reviewer.email },
      }).catch(() => {});

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /account — requires sessionAuth. Anonymizes and deactivates account.
  router.delete("/account", sessionAuth(db), async (req, res, next) => {
    try {
      const sessionReviewer = (req as any).reviewer;

      const [reviewer] = await db
        .select()
        .from(reviewers)
        .where(eq(reviewers.id, sessionReviewer.id))
        .limit(1);

      if (!reviewer) {
        throw new AuthenticationError("Reviewer not found", "invalid_credentials");
      }

      // Which credential is required depends on where this account's password
      // actually lives, so the reviewer row has to be loaded before the check
      // rather than after. See lib/account-deletion.ts.
      await assertDeletionCredential(reviewer, req.body ?? {});

      // Log before anonymization so audit entry has real email/id. Unlike
      // most audit calls in this file, this one is awaited (still swallowing
      // failure, so a transient audit-write error can't block deletion):
      // anonymizeAuditLogRows() below scrubs this reviewer's audit rows,
      // and this entry's own { email, name } must already be committed when
      // that runs, or a fire-and-forget write racing past the scrub would be
      // the one row in the table that keeps plaintext PII forever.
      await auditService.log({
        action: "account.deleted",
        actor: reviewer.id,
        resource_type: "reviewer",
        resource_id: reviewer.id,
        details: { email: reviewer.email, name: reviewer.name },
      }).catch(() => {});

      // Everything below is local Postgres state describing "this account is
      // deleted" (the row itself, its dependent tables, its audit trail, its
      // sessions). None of it was previously transactional — ~6 sequential
      // auto-committed statements — so a failure partway (a dropped
      // connection after the reviewers UPDATE, say) could leave the account
      // anonymized/deactivated while notifications/slackUserLinks rows or a
      // non-anonymized audit trail survive it, for data that has no other
      // deletion path (see the comment below). One transaction makes it
      // all-or-nothing. The remote Supabase call stays outside it deliberately
      // — see the comment further down.
      await db.transaction(async (tx) => {
        await tx
          .update(reviewers)
          .set({
            email: `deleted-${reviewer.id}@deleted.local`,
            name: "Deleted User",
            password_hash: "$2a$10$deleted",
            // Clearing the Supabase link is what actually revokes Cloud access.
            // Cloud auth resolves a reviewer by looking this column up
            // (ee/auth/cloud-auth-helper.ts), so nulling it makes every existing
            // Supabase JWT for this person resolve to nobody — and unlike the
            // remote delete below, it cannot fail on a third-party outage. It is
            // also a third-party identifier for this person in its own right.
            supabase_user_id: null,
            is_active: false,
            totp_secret_encrypted: null,
            totp_enabled_at: null,
            totp_backup_codes: null,
            updated_at: new Date(),
          })
          .where(eq(reviewers.id, reviewer.id));

        // The reviewers row above is anonymized in place, never deleted, so no
        // foreign key cascade (migration 086) ever fires for it. None of these
        // four tables has any other deletion path today, so without this they
        // would keep this reviewer's personal data (notification titles, their
        // notification preferences, their Slack user id, which identifies
        // them in a third-party system, and any product_feedback free text
        // they submitted) forever.
        await tx.delete(notifications).where(eq(notifications.reviewer_id, reviewer.id));
        await tx.delete(notificationPreferences).where(eq(notificationPreferences.reviewer_id, reviewer.id));
        await tx.delete(slackUserLinks).where(eq(slackUserLinks.reviewer_id, reviewer.id));
        await tx.delete(productFeedback).where(eq(productFeedback.subject, reviewer.id));

        // Strip the personal fields from this reviewer's own audit trail rather
        // than deleting the rows, so the log still shows that the actions
        // happened, just not who by anymore. Matched across every actor format
        // this reviewer can have been written as, not just their bare id — see
        // reviewerActorValues(). Uses the pre-anonymization email, so this must
        // stay after the audit write above and before nothing that needs it.
        await anonymizeAuditLogForReviewer(tx, { id: reviewer.id, email: reviewer.email });

        await createSessionService(tx).revokeAll(reviewer.id);
      });

      // Remove the account from Supabase too, so erasure covers the copy of
      // the email address held there, and so the address can be reused to sign
      // up again. Swallowed like the equivalent call in ee/jobs/data-cleanup.ts:
      // the local erasure has already committed, and access was revoked by
      // clearing supabase_user_id above, so a Supabase outage must not turn a
      // completed deletion into a 500 the user would retry against a
      // now-anonymized row. Unlike the previous `console.error`-only handling,
      // this is now recorded the same durable way data-cleanup.ts's own
      // "equivalent call" already does (identity.deletion_failed) — a
      // server-log line is not discoverable by anyone once it scrolls past,
      // and this is the account's own Supabase identity outliving its owner's
      // deletion request indefinitely with nothing to say so.
      if (reviewer.supabase_user_id) {
        try {
          const ee = await loadCloudDeletion();
          await ee.deleteCloudAuthUser(reviewer.supabase_user_id);
        } catch (err) {
          console.error("[account] Supabase user deletion failed for", reviewer.id, err);
          await auditService.log({
            action: "identity.deletion_failed",
            actor: "system:account_deletion",
            resource_type: "reviewer",
            resource_id: reviewer.id,
            details: {
              supabase_user_id: reviewer.supabase_user_id,
              error: err instanceof Error ? err.message : String(err),
              consequence:
                "local account already anonymized and access revoked; Supabase identity survives until retried",
            },
          }).catch((auditErr: unknown) => {
            console.error("[account] identity.deletion_failed audit write failed", auditErr);
          });
        }
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // GET /account/deletion-challenge — requires sessionAuth. Tells the client
  // which credential DELETE /account will ask for. Cloud accounts created
  // through Google or GitHub have no password in any store, so the UI cannot
  // assume a password field. Returns no personal data beyond what the caller
  // already has about themselves.
  router.get("/account/deletion-challenge", sessionAuth(db), async (req, res, next) => {
    try {
      const sessionReviewer = (req as any).reviewer;

      const [reviewer] = await db
        .select({ supabase_user_id: reviewers.supabase_user_id })
        .from(reviewers)
        .where(eq(reviewers.id, sessionReviewer.id))
        .limit(1);

      if (!reviewer) {
        throw new AuthenticationError("Reviewer not found", "invalid_credentials");
      }

      res.json({ method: await resolveDeletionChallenge(reviewer) });
    } catch (err) {
      next(err);
    }
  });

  // GET /data-export — requires sessionAuth. Returns reviewer data as JSON attachment.
  router.get("/data-export", sessionAuth(db), async (req, res, next) => {
    try {
      const sessionReviewer = (req as any).reviewer;

      const [reviewer] = await db
        .select({
          id: reviewers.id,
          email: reviewers.email,
          name: reviewers.name,
          role: reviewers.role,
          created_at: reviewers.created_at,
          last_login_at: reviewers.last_login_at,
          email_verified_at: reviewers.email_verified_at,
        })
        .from(reviewers)
        .where(eq(reviewers.id, sessionReviewer.id))
        .limit(1);

      if (!reviewer) {
        throw new AuthenticationError("Reviewer not found", "invalid_credentials");
      }

      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

      const authLogs = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.actor, sessionReviewer.id),
            like(auditLog.action, "auth.%"),
            gt(auditLog.created_at, ninetyDaysAgo),
          ),
        );

      auditService.log({
        action: "account.data_exported",
        actor: sessionReviewer.id,
        resource_type: "reviewer",
        resource_id: sessionReviewer.id,
        details: {},
      }).catch(() => {});

      res.setHeader("Content-Disposition", 'attachment; filename="gatewerk-data-export.json"');
      res.json({
        exported_at: new Date().toISOString(),
        profile: reviewer,
        auth_events_last_90_days: authLogs,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /preferences — requires sessionAuth. Returns login_notifications and notification_preferences.
  router.get("/preferences", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const reviewerId = reviewer.id;

      const [rev] = await db
        .select()
        .from(reviewers)
        .where(eq(reviewers.id, reviewerId))
        .limit(1);

      const [pref] = await db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.reviewer_id, reviewerId))
        .limit(1);

      res.json({
        login_notifications: rev?.login_notifications ?? true,
        notifications: pref?.prefs ?? DEFAULT_NOTIFICATION_PREFS,
      });
    } catch (err) {
      next(err);
    }
  });

  // PUT /preferences — requires sessionAuth. Updates login_notifications preference and/or notification_preferences.
  router.put("/preferences", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const { login_notifications, notifications } = req.body ?? {};

      if (login_notifications !== undefined) {
        if (typeof login_notifications !== "boolean") {
          throw new InvalidRequestError(
            "login_notifications must be a boolean",
            "login_notifications",
            "invalid_type",
          );
        }

        await db
          .update(reviewers)
          .set({ login_notifications, updated_at: new Date() })
          .where(eq(reviewers.id, reviewer.id));
      }

      if (notifications !== undefined) {
        const parsed = NotificationPrefsSchema.safeParse(notifications);
        if (!parsed.success) {
          throw new ValidationError("body", parsed.error.issues);
        }
        const prefs = parsed.data;
        await db
          .insert(notificationPreferences)
          .values({ reviewer_id: reviewer.id, prefs, updated_at: new Date() })
          .onConflictDoUpdate({
            target: notificationPreferences.reviewer_id,
            set: { prefs, updated_at: new Date() },
          });
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // PUT /avatar — requires sessionAuth. Body: { data: "data:image/...;base64,..." }.
  router.put("/avatar", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const { data } = req.body ?? {};

      if (typeof data !== "string") {
        throw new InvalidRequestError("data is required", "data", "missing_data");
      }

      const match = data.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        throw new InvalidRequestError(
          "data must be a base64 data URL",
          "data",
          "invalid_format",
        );
      }

      const declaredType = match[1].toLowerCase();
      if (!ALLOWED_AVATAR_TYPES.has(declaredType)) {
        throw new InvalidRequestError(
          "Avatar must be PNG, JPEG, or WebP",
          "data",
          "unsupported_type",
        );
      }

      const buffer = Buffer.from(match[2], "base64");
      if (buffer.length === 0 || buffer.length > MAX_AVATAR_BYTES) {
        throw new InvalidRequestError(
          `Avatar must be under ${MAX_AVATAR_BYTES / 1024}KB`,
          "data",
          "too_large",
        );
      }

      // The declared type is a claim from the request body; the sniffed type
      // is what the bytes actually are. Both must agree, and it is the
      // sniffed type that gets stored and served — never the declared one.
      const sniffedType = sniffImageType(buffer);
      if (!sniffedType || sniffedType !== declaredType) {
        throw new InvalidRequestError(
          "File content does not match its declared type",
          "data",
          "type_mismatch",
        );
      }

      const avatar_updated_at = new Date();
      await db
        .update(reviewers)
        .set({
          avatar_data: buffer,
          avatar_content_type: sniffedType,
          avatar_updated_at,
          updated_at: avatar_updated_at,
        })
        .where(eq(reviewers.id, reviewer.id));

      auditService.log({
        action: "account.avatar_updated",
        actor: reviewer.id,
        resource_type: "reviewer",
        resource_id: reviewer.id,
        details: {},
      }).catch(() => {});

      res.json({ ok: true, avatar_updated_at: avatar_updated_at.toISOString() });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /avatar — requires sessionAuth. Reverts to the initials fallback.
  router.delete("/avatar", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;

      await db
        .update(reviewers)
        .set({
          avatar_data: null,
          avatar_content_type: null,
          avatar_updated_at: null,
          updated_at: new Date(),
        })
        .where(eq(reviewers.id, reviewer.id));

      auditService.log({
        action: "account.avatar_removed",
        actor: reviewer.id,
        resource_type: "reviewer",
        resource_id: reviewer.id,
        details: {},
      }).catch(() => {});

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // GET /avatar/:id — PUBLIC, not sessionAuth. An avatar is a photo someone
  // chose to represent themselves with, not confidential document content
  // the way review attachments can be — and this is deliberately unauthed so
  // a plain <img src> works everywhere it's used. The `id` is the entire
  // gate: reviewer ids are long, unguessable strings, the same posture
  // require-media-access.ts's own doc comment accepts for stored media keys.
  // No route in this file is public elsewhere; this one is the exception,
  // and it stays narrow — bytes out, nothing else about the reviewer.
  router.get("/avatar/:id", async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const [row] = await db
        .select({
          avatar_data: reviewers.avatar_data,
          avatar_content_type: reviewers.avatar_content_type,
          avatar_updated_at: reviewers.avatar_updated_at,
        })
        .from(reviewers)
        .where(eq(reviewers.id, id))
        .limit(1);

      if (!row?.avatar_data || !row.avatar_content_type) {
        // no-store: a browser that cached this 404 from before a photo was
        // uploaded must not keep believing there's nothing here.
        res.setHeader("Cache-Control", "no-store");
        res.status(404).json(new NotFoundError("No avatar set", "avatar_not_found").toJSON());
        return;
      }

      const etag = `"${row.avatar_updated_at?.getTime() ?? 0}"`;
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }

      res.setHeader("Content-Type", row.avatar_content_type);
      // no-cache (NOT no-store): the browser may keep the bytes, but must
      // revalidate with the server on every use rather than trusting a
      // max-age window blindly. A photo upload/removal changes what this
      // exact URL serves without the URL itself changing (no cache-busting
      // query param on most call sites — PersonAvatar, ActorRow, the thread
      // composer), so a long max-age meant the browser kept serving
      // yesterday's bytes for up to 24h after a removal, "Removed" toast
      // notwithstanding. The ETag above makes revalidation cheap: a 304 on
      // every unchanged load, not a re-transfer of the image bytes.
      res.setHeader("Cache-Control", "private, no-cache");
      res.setHeader("ETag", etag);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(Buffer.from(row.avatar_data));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

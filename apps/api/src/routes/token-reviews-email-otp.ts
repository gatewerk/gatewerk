import type { Request, Response, NextFunction } from "express";
import {
  InvalidRequestError,
  NotFoundError,
  GatewerkError,
} from "@gatewerk/shared";
import type { createReviewTokenService } from "../services/review-tokens";
import type { createEmailOtpStore } from "../services/email-otp/store";
import { OTP_CONSTANTS } from "../services/email-otp/store";
import { serverEnv } from "../env";
import { generateOtpCode, hashOtpCode, verifyOtpCode } from "../services/email-otp/codes";
import { renderEmail, OtpCodeEmail } from "@gatewerk/emails";
import { config } from "../config";
import {
  recipientSessionCookieName,
  RECIPIENT_SESSION_TTL_SECONDS,
  signRecipientSession,
} from "../services/token-recipient-session";
import type { EmailService } from "../services/email";
import type { createAuditService } from "../services/audit";
import { randomBytes } from "node:crypto";

/**
 * Email-OTP /request and /verify route handlers (token redesign §6.2).
 * Extracted from routes/token-reviews.ts to keep that file under the
 * project's 600-line max-lines cap (CI-enforced via eslint max-lines). Pure delegation — no logic
 * change vs the inline handlers; signatures take the same dependency
 * set the parent route had captured in closure.
 */

type TokenService = ReturnType<typeof createReviewTokenService>;
type OtpStore = ReturnType<typeof createEmailOtpStore>;
type AuditService = ReturnType<typeof createAuditService>;

function newOtpSendIdempotencyKey(): string {
  return `otpsend_${randomBytes(8).toString("hex")}`;
}

export interface EmailOtpHandlerDeps {
  tokenService: TokenService;
  otpStore: OtpStore;
  emailService: EmailService | undefined;
  auditService: AuditService | undefined;
  /**
   * Masks the human who CREATED the link, for the "shared with you by A***"
   * line in the OTP email. Injected rather than imported: resolveSenderHint
   * lives in token-reviews.ts, which imports this module, so importing it
   * back would make a cycle.
   *
   * Optional, defaulting to "" — the hint is a courtesy the copy already
   * drops gracefully, exactly as resolveSenderHint itself does on a lookup
   * failure. A caller that omits it gets the generic sentence, never an error.
   */
  resolveSenderHint?: (
    tokenRecord:
      | { created_by_kind?: string | null; created_by_id?: string | null }
      | null
      | undefined,
  ) => Promise<string>;
}

export function makeEmailOtpRequestHandler(deps: EmailOtpHandlerDeps) {
  const { tokenService, otpStore, emailService, auditService } = deps;
  const resolveSenderHint = deps.resolveSenderHint ?? (async () => "");
  return async function emailOtpRequest(req: Request, res: Response, next: NextFunction) {
    try {
      const token = String(req.params.token);
      if (!token.startsWith("gw_tok_")) {
        throw new InvalidRequestError("Invalid token format", "token", "invalid_token_format");
      }
      const { email } = req.body ?? {};
      if (typeof email !== "string" || email.trim().length === 0) {
        throw new InvalidRequestError(
          "Missing required field: email",
          "email",
          "missing_required_fields",
        );
      }

      const validation = await tokenService.validate(token);
      if (!validation || validation.status !== "valid") {
        // Uniform "invalid" surface to avoid revealing exists/used/expired
        // distinctions to unauthenticated probing.
        throw new NotFoundError("This review link is invalid.", "token_invalid");
      }
      const tokenRecord = validation.tokenRecord;
      if (tokenRecord.auth_level !== "email_otp") {
        throw new InvalidRequestError(
          "This token does not use email verification.",
          "token",
          "auth_level_mismatch",
        );
      }

      // Token-level lock check applies to BOTH /request and /verify so an
      // attacker cannot pivot between them after exhausting attempts.
      const lockedUntil = await otpStore.readLock(tokenRecord.id);
      if (lockedUntil) {
        // Audit emit shape used at every site in this file: guard on
        // `auditService` then call `.catch(() => {})`. NOT
        // `auditService?.log(...).catch(...)` — optional-chain on an
        // undefined service yields `undefined`, and `.catch` on
        // `undefined` is a TypeError that crashes the request. Audit is
        // a side channel; failure must never block the recipient
        // response.
        if (auditService) {
          auditService.log({
            action: "token.email_otp_locked",
            actor: `token:${tokenRecord.id}`,
            resource_type: "review",
            resource_id: tokenRecord.review_id,
            details: { phase: "request", ip_address: req.ip ?? "unknown" },
            project_id: tokenRecord.project_id,
          }).catch(() => {});
        }
        throw new GatewerkError(
          "This link is temporarily locked due to too many failed verification attempts. Try again later or request a new link from the sender.",
          423,
          "rate_limit",
          "token_locked",
        );
      }

      // Email match — case-insensitive trim.
      const submittedEmail = email.trim().toLowerCase();
      const expectedEmail = (tokenRecord.auth_email ?? "").trim().toLowerCase();
      if (!expectedEmail || submittedEmail !== expectedEmail) {
        if (auditService) {
          auditService.log({
            action: "token.email_otp_wrong_email",
            actor: `token:${tokenRecord.id}`,
            resource_type: "review",
            resource_id: tokenRecord.review_id,
            details: {
              submitted_email: submittedEmail.slice(0, 64),
              ip_address: req.ip ?? "unknown",
            },
            project_id: tokenRecord.project_id,
          }).catch(() => {});
        }
        throw new InvalidRequestError(
          "This link is not for that email address. Check the email it was sent to.",
          "email",
          "email_mismatch",
        );
      }

      // Resend cooldown — 60s since most-recent send.
      const lastSent = await otpStore.getMostRecentSendAt(tokenRecord.id);
      if (lastSent && Date.now() - lastSent.getTime() < OTP_CONSTANTS.RESEND_COOLDOWN_MS) {
        throw new GatewerkError(
          "Please wait a moment before requesting another code.",
          429,
          "rate_limit",
          "resend_cooldown",
        );
      }

      // Generate + hash, then send FIRST, then persist on success branches.
      // Persisting upfront would leave a row whose created_at trips the
      // 60s resend cooldown on the next /request even when the recipient
      // never received a code (transient SMTP failure / rate_limited
      // upstream). The cooldown gate is supposed to limit successful
      // sends, not penalize the recipient for our own delivery hiccup.
      const code = generateOtpCode();
      const codeHash = hashOtpCode(code);

      // Context, so the mail is not a bare number to a cold reader. The review
      // TITLE is deliberately NOT carried: this is an auth step, not a
      // notification, and the title would land in an inbox we do not control,
      // sometimes a shared one (ruled, EMAIL_BUILD_SPEC §9 Q1).
      const senderHint = await resolveSenderHint(tokenRecord);
      const { subject, text, html } = await renderEmail(OtpCodeEmail, {
        code,
        senderHint,
        logoUrl: config.emailLogoUrl,
      });
      const idempotencyKey = newOtpSendIdempotencyKey();
      // emailService optional for back-compat with pre-OTP callers; when
      // undefined we synthesize `skipped_no_config` so the switch stays
      // exhaustive and an unconfigured operator does not leak deployment
      // state to an unauthenticated probe via a divergent error shape.
      //
      // Deliberately does NOT pass organization_id here. Doing so would opt
      // this send into the per-tenant deliverability breaker (Stage 5a,
      // apps/api/src/services/email/index.ts), which can silently drop mail
      // for a paused tenant. An OTP is how an external reviewer proves who
      // they are to reach a review at all, so blocking it because the
      // tenant is paused would lock them out of the exact review the
      // breaker is meant to protect. See notification-email-handler.ts /
      // notification-digest-handler.ts for the mail that IS meant to opt in.
      const sendResult = emailService
        ? await emailService.sendEmail({
            to: submittedEmail,
            subject,
            text,
            html,
            idempotencyKey,
            sourceIp: req.ip,
          })
        : ({ status: "skipped_no_config" } as const);

      // Single emit shape for "presented as success" branches —
      // sent/deduped persist the code row; skipped_no_config does not
      // (no recipient-receivable code to verify) but returns the same
      // success surface so a misconfigured operator does not leak that
      // fact to an attacker probing for token validity.
      const emitSentAuditAndReturn = (sendStatus: string) => {
        if (auditService) {
          auditService.log({
            action: "token.email_otp_sent",
            actor: `token:${tokenRecord.id}`,
            resource_type: "review",
            resource_id: tokenRecord.review_id,
            details: { email: submittedEmail, ip_address: req.ip ?? "unknown", send_status: sendStatus },
            project_id: tokenRecord.project_id,
          }).catch(() => {});
        }
        return res.json({ status: "sent" });
      };

      switch (sendResult.status) {
        case "sent":
        case "deduped":
          await otpStore.createCode({ tokenId: tokenRecord.id, email: submittedEmail, codeHash });
          return emitSentAuditAndReturn(sendResult.status);

        case "skipped_no_config":
          // Audit emit preserves anti-enumeration uniformity for the
          // unauthenticated probe surface, but the misconfiguration MUST
          // be observable to operators. Without this stderr line, an OSS
          // deployment with no SMTP config silently locks out every
          // email-OTP recipient (audit emits success and the recipient
          // waits forever for a code that was never sent).
          console.error(
            "[token-reviews-email-otp] emailService not configured — recipient %s for token %s received no OTP code. Configure SMTP_* env vars.",
            submittedEmail,
            tokenRecord.id,
          );
          return emitSentAuditAndReturn("skipped_no_config");

        case "rate_limited":
          // No code row persisted — would block recovery via the 60s
          // resend cooldown gate even though the recipient received no
          // email.
          throw new GatewerkError(
            "Too many code requests. Try again later.",
            429,
            "rate_limit",
            "email_rate_limited",
          );

        case "suppressed":
          // Recipient address is on the suppression list (bounce/complaint/
          // unsubscribe). Treat identically to failed from the recipient's
          // perspective — no code row persisted — but surface a friendlier
          // message. No code row means the recipient can retry after the
          // suppression is cleared by an operator.
          throw new GatewerkError(
            "We could not send the verification code. Please try again.",
            502,
            "internal",
            "email_send_failed",
          );

        case "failed":
          // No code row persisted — same recovery rationale as
          // rate_limited above. Operator-side email.send_failed audit
          // is emitted by the email service.
          throw new GatewerkError(
            "We could not send the verification code. Please try again.",
            502,
            "internal",
            "email_send_failed",
          );

        case "tenant_paused":
          // This call site never sets organization_id, so the deliverability
          // breaker can never actually gate an OTP send today. Handled here
          // only to satisfy exhaustiveness; treated identically to failed if
          // a future call site attributes a tenant to this path.
          throw new GatewerkError(
            "We could not send the verification code. Please try again.",
            502,
            "internal",
            "email_send_failed",
          );

        default: {
          // Exhaustiveness — if a new SendEmailResult variant is added,
          // TS forces this branch to update.
          const _exhaustive: never = sendResult;
          void _exhaustive;
          throw new Error("unreachable");
        }
      }
    } catch (err) {
      next(err);
    }
  };
}

export function makeEmailOtpVerifyHandler(deps: EmailOtpHandlerDeps) {
  const { tokenService, otpStore, auditService } = deps;
  return async function emailOtpVerify(req: Request, res: Response, next: NextFunction) {
    try {
      const token = String(req.params.token);
      if (!token.startsWith("gw_tok_")) {
        throw new InvalidRequestError("Invalid token format", "token", "invalid_token_format");
      }
      const { code } = req.body ?? {};
      if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
        // Keystroke errors are noisy; the IP-keyed rate limiter caps abuse
        // and we skip auditing the malformed-shape case.
        throw new InvalidRequestError("Code must be 6 digits.", "code", "invalid_code_format");
      }

      const validation = await tokenService.validate(token);
      if (!validation || validation.status !== "valid") {
        throw new NotFoundError("This review link is invalid.", "token_invalid");
      }
      const tokenRecord = validation.tokenRecord;
      if (tokenRecord.auth_level !== "email_otp") {
        throw new InvalidRequestError(
          "This token does not use email verification.",
          "token",
          "auth_level_mismatch",
        );
      }

      const lockedUntil = await otpStore.readLock(tokenRecord.id);
      if (lockedUntil) {
        if (auditService) {
          auditService.log({
            action: "token.email_otp_locked",
            actor: `token:${tokenRecord.id}`,
            resource_type: "review",
            resource_id: tokenRecord.review_id,
            details: { phase: "verify", ip_address: req.ip ?? "unknown" },
            project_id: tokenRecord.project_id,
          }).catch(() => {});
        }
        throw new GatewerkError(
          "This link is temporarily locked due to too many failed verification attempts.",
          423,
          "rate_limit",
          "token_locked",
        );
      }

      const active = await otpStore.getActiveCode(tokenRecord.id);
      if (!active) {
        // No active code — never requested OR last code expired. Uniform
        // user-facing error; audit distinguishes for ops debugging.
        if (auditService) {
          auditService.log({
            action: "token.email_otp_expired",
            actor: `token:${tokenRecord.id}`,
            resource_type: "review",
            resource_id: tokenRecord.review_id,
            details: { ip_address: req.ip ?? "unknown" },
            project_id: tokenRecord.project_id,
          }).catch(() => {});
        }
        throw new GatewerkError(
          "This code has expired. Request a new code.",
          410,
          "validation",
          "code_expired",
        );
      }

      if (verifyOtpCode(code, active.code_hash)) {
        await otpStore.markVerified(active.id);
        const sessionJwt = signRecipientSession({
          sub: tokenRecord.id,
          email: active.email,
        });
        const isProd = serverEnv.NODE_ENV === "production";
        res.cookie(recipientSessionCookieName(tokenRecord.id), sessionJwt, {
          httpOnly: true,
          secure: isProd,
          sameSite: "strict",
          // RFC 6265 §5.3 path-matching: cookie Path must prefix-match the
          // request URI for the browser to include it. The recipient API
          // endpoints live under /api/v1/r/* — a Path of "/r" would NOT
          // match /api/v1/r/:token/decide and the browser would silently
          // omit the cookie. The unauthenticated React /r/:token route
          // never reads cookies, so scoping at the API path is also OWASP
          // A05 least-privilege.
          path: "/api/v1/r",
          maxAge: RECIPIENT_SESSION_TTL_SECONDS * 1000,
        });
        if (auditService) {
          auditService.log({
            action: "token.email_otp_verified",
            actor: `token:${tokenRecord.id}`,
            resource_type: "review",
            resource_id: tokenRecord.review_id,
            details: { email: active.email, ip_address: req.ip ?? "unknown" },
            project_id: tokenRecord.project_id,
          }).catch(() => {});
        }
        return res.json({ status: "verified" });
      }

      // Wrong code — atomic increment, lock at MAX, audit.
      const newAttempts = await otpStore.incrementAttempts(active.id);
      if (newAttempts >= OTP_CONSTANTS.MAX_ATTEMPTS) {
        await otpStore.lockToken(tokenRecord.id);
        if (auditService) {
          auditService.log({
            action: "token.email_otp_locked",
            actor: `token:${tokenRecord.id}`,
            resource_type: "review",
            resource_id: tokenRecord.review_id,
            details: {
              phase: "verify",
              trigger: "max_attempts",
              ip_address: req.ip ?? "unknown",
            },
            project_id: tokenRecord.project_id,
          }).catch(() => {});
        }
        throw new GatewerkError(
          "Too many wrong attempts. This link is now locked. Try again later or request a new link.",
          423,
          "rate_limit",
          "token_locked",
        );
      }
      if (auditService) {
        auditService.log({
          action: "token.email_otp_failed",
          actor: `token:${tokenRecord.id}`,
          resource_type: "review",
          resource_id: tokenRecord.review_id,
          details: { attempts: newAttempts, ip_address: req.ip ?? "unknown" },
          project_id: tokenRecord.project_id,
        }).catch(() => {});
      }
      const remaining = OTP_CONSTANTS.MAX_ATTEMPTS - newAttempts;
      throw new GatewerkError(
        `Wrong code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
        400,
        "validation",
        "wrong_code",
      );
    } catch (err) {
      next(err);
    }
  };
}


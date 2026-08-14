import { Router } from "express";
import { eq } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import { createReviewTokenService } from "../services/review-tokens";
import { WebhookService } from "../services/webhooks";
import { reviewTokens, reviews as reviewsTable, reviewers as reviewersTable } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import type { SessionResult } from "../lib/auth-helpers";
import { maskEmail } from "../lib/mask-email";
import {
  handleAccountTierGet,
  handleAccountTierDecidePreflight,
  stampAccountTierDecided,
} from "./token-reviews-account-tier";
import {
  makeEmailOtpRequestHandler,
  makeEmailOtpVerifyHandler,
} from "./token-reviews-email-otp";
import { externalDeciderActor } from "../lib/external-decider";
import { createRecipientActionRoutes } from "./token-reviews-recipient-actions";
import { createTokenActionRoutes } from "./token-reviews-action";
import {
  InvalidRequestError,
  NotFoundError,
  GoneError,
  GatewerkError,
  AuthenticationError,
  normalizeTemplateActions,
  ReviewDecideBodySchema,
} from "@gatewerk/shared";
import { validate } from "../middleware/validate";
import { normalizeTemplateFields } from "../services/reviews/_queries";
import type { EventBus } from "../services/events";
import type { createAuditService } from "../services/audit";
import { executeReviewAction } from "../services/reviews/execute-action";
import type { EmailService } from "../services/email";
import { createEmailOtpStore } from "../services/email-otp/store";
import { serverEnv } from "../env";
import {
  recipientSessionCookieName,
  signRecipientSession,
  verifyRecipientSession,
  RECIPIENT_SESSION_TTL_SECONDS,
} from "../services/token-recipient-session";

// In the test path the /r/:token routes are exercised many times from
// loopback — sharing the same IP across the suite would trip the cap
// before the suite finishes. Skip in test env so the test surface
// reflects route logic, not the throttle. Production / dev keep the
// real ceiling.
//
// Resolved per-call (not captured at module load) so a test can stub
// VITEST=false + vi.resetModules() to exercise the live limiter path
// without rebuilding the route module from scratch — same pattern as
// the recipient session cookie name's NODE_ENV-dependent resolution.
function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

const tokenRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTestEnv(),
  message: {
    error: {
      type: "rate_limit",
      code: "rate_limit_exceeded",
      message: "Too many requests. Try again in a minute.",
    },
  },
});

// IP-keyed rate limiter for /verify. Applied BEFORE the DB lookup so an
// attacker without a valid token cannot enumerate via timing or exhaust
// the DB on guesses. 10 attempts per 5min per IP — ample for a real
// recipient who fat-fingered the code, tight enough to make automated
// guessing infeasible against the 10^6 keyspace + 5-strike token-level
// lockout.
//
// keyGenerator is intentionally omitted: the express-rate-limit v8 default
// wraps req.ip in ipKeyGenerator(ip, /56), collapsing IPv6 /56 prefixes so
// an attacker on a /48 cannot rotate /128 addresses to bypass the cap. Do
// NOT replace with `(req) => req.ip` — that triggers ERR_ERL_KEY_GEN_IPV6
// and re-introduces the bypass (RFC 4291 IPv6 addressing architecture).
const otpVerifyRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTestEnv(),
  message: {
    error: {
      type: "rate_limit",
      code: "rate_limit_exceeded",
      message: "Too many verification attempts. Try again in a few minutes.",
    },
  },
});

/**
 * Mask the recipient label for display on terminal states (expired, locked,
 * account mismatch). Shows only the first character + *** so the recipient
 * can confirm who sent the review without leaking the full label to anyone
 * who lands on the link. Returns "" when the input is null/empty to avoid
 * leaking that the token has no recipient label.
 *
 * Examples: "Jordan" → "J***", "j@ex.com" → "j***", null → "".
 */
export function maskSenderLabel(label: string | null | undefined): string {
  if (!label) return "";
  return `${label[0]}***`;
}

/**
 * Who sent this link, masked.
 *
 * This used to mask the token's `recipient_label`, which meant the page told a
 * recipient "from <their own label>" — the sender field showed the reader
 * themselves. Resolve the human who created the link instead, masked to a
 * single character exactly as before so an unauthenticated visitor learns no
 * more than they already did. Agent- and chain-created links have no human
 * sender; they return "" and the page drops the line entirely.
 */
export async function resolveSenderHint(
  db: AppDb,
  tokenRecord: {
    created_by_kind?: string | null;
    created_by_id?: string | null;
  } | null | undefined,
): Promise<string> {
  if (!tokenRecord || tokenRecord.created_by_kind !== "manual") return "";
  if (!tokenRecord.created_by_id) return "";
  try {
    const [sender] = await db
      .select({ name: reviewersTable.name, email: reviewersTable.email })
      .from(reviewersTable)
      .where(eq(reviewersTable.id, tokenRecord.created_by_id))
      .limit(1);
    if (!sender) return "";
    return maskSenderLabel(sender.name || sender.email);
  } catch {
    // The hint is a courtesy, never load-bearing — a lookup failure must not
    // turn a valid link into an error page.
    return "";
  }
}

export function createTokenReviewRoutes(
  db: AppDb,
  eventBus?: EventBus,
  auditService?: ReturnType<typeof createAuditService>,
  webhooks?: WebhookService,
  emailService?: EmailService,
): Router {
  const router = Router();
  const tokenService = createReviewTokenService(db);
  const wh = webhooks || new WebhookService({ db });
  const otpStore = createEmailOtpStore(db);

  // GET /r/:token — validate token and return review data.
  router.get("/:token", tokenRateLimiter, async (req, res, next) => {
    try {
      const token = String(req.params.token);

      if (!token || !token.startsWith("gw_tok_")) {
        throw new InvalidRequestError("Invalid token format", "token", "invalid_token_format");
      }

      const result = await tokenService.validate(token);

      if (!result) {
        throw new NotFoundError("This review link is invalid.", "token_invalid");
      }

      // Record first open for the grace period.
      if (result.status === "valid" && !result.tokenRecord?.opened_at) {
        await db
          .update(reviewTokens)
          .set({ opened_at: new Date() })
          .where(eq(reviewTokens.id, result.tokenRecord.id));
      }

      // Check expiry with 4-hour grace period from first open. On hard
      // expiry we return an explicit 410 (not GoneError) so the body can
      // carry the masked sender_hint — a recipient who visits an expired
      // link directly still sees "Sent by X***" for context.
      if (result.status === "expired") {
        const GRACE_PERIOD_MS = 4 * 60 * 60 * 1000;
        const openedAt = result.tokenRecord?.opened_at;
        const sender_hint = await resolveSenderHint(db, result.tokenRecord);

        if (openedAt) {
          const graceExpires = new Date(openedAt).getTime() + GRACE_PERIOD_MS;
          if (Date.now() >= graceExpires) {
            return res.status(410).json({
              status: "expired",
              sender_hint,
              message: "This review link has expired. Please request a new link from the sender.",
            });
          }
        } else {
          return res.status(410).json({
            status: "expired",
            sender_hint,
            message: "This review link has expired.",
          });
        }
      }

      if (result.status === "used") {
        return res.status(410).json({
          status: "used",
          decision: result.review.decision,
          decided_at: result.review.decided_at,
          message: "This review has already been decided.",
        });
      }

      // Operator revoked the token. Surface a distinct terminal state so
      // the UI shows "this link has been revoked" rather than the review
      // payload (which the recipient should no longer be able to act on).
      if (result.status === "revoked") {
        return res.status(410).json({
          status: "revoked",
          message: "This review link has been revoked.",
        });
      }

      const tokenRecord = result.tokenRecord;

      // Email-OTP gate. Token redesign §6.2: when auth_level === "email_otp"
      // a verified recipient session cookie is required before the review
      // payload is exposed. The cookie is issued by /email-otp/verify,
      // signed with audience "token-recipient" and subject = token_id.
      if (tokenRecord.auth_level === "email_otp") {
        const cookieValue = req.cookies?.[recipientSessionCookieName(tokenRecord.id)];
        const session = cookieValue
          ? verifyRecipientSession(cookieValue, tokenRecord.id)
          : null;

        if (!session) {
          // Surface the masked auth_email so the recipient can confirm
          // they expected this address. cookie_invalid signals to the
          // client that any present cookie is stale and should be
          // cleared (subject mismatch, expiry, or tampering).
          if (cookieValue) {
            // RFC 6265 §5.3 — HttpOnly cookies cannot be cleared from JS,
            // so the server evicts; without this the stale cookie sticks
            // for 30min and confuses subsequent recipient-link visits.
            res.clearCookie(recipientSessionCookieName(tokenRecord.id), { path: "/api/v1/r" });
            if (auditService) {
              auditService.log({
                action: "token.recipient_session_invalidated",
                actor: `token:${tokenRecord.id}`,
                resource_type: "review",
                resource_id: tokenRecord.review_id,
                details: { reason: "subject_mismatch_or_expired", ip_address: req.ip ?? "unknown" },
                project_id: tokenRecord.project_id,
              }).catch(() => {});
            }
          }
          return res.json({
            status: "valid",
            requires_email_otp: true,
            recipient_email_hint: maskEmail(tokenRecord.auth_email),
            sender_hint: await resolveSenderHint(db, tokenRecord),
            cookie_invalid: cookieValue ? true : undefined,
          });
        }

        // Sliding expiry. The session lasts 30 minutes, but the task on this
        // page is "read a proposal, think, decide" — a recipient who reads
        // carefully was being bounced back to re-verify mid-decision. Re-issue
        // the cookie on every authenticated load so the window measures
        // inactivity rather than total time. The JWT is re-signed (not just
        // re-set) so its own exp moves with it; subject stays bound to this
        // token, so nothing widens.
        const refreshed = signRecipientSession({
          sub: tokenRecord.id,
          email: session.email,
        });
        res.cookie(recipientSessionCookieName(tokenRecord.id), refreshed, {
          httpOnly: true,
          secure: serverEnv.NODE_ENV === "production",
          sameSite: "strict",
          path: "/api/v1/r",
          maxAge: RECIPIENT_SESSION_TTL_SECONDS * 1000,
        });
      }

      // Account-bound gate. Token redesign §6.2 — reuses the main-app
      // Bearer JWT (sessionStorage / localStorage) for identity. Helpers
      // owned by ./token-reviews-account-tier so this route file stays
      // under the project's 600-line max-lines cap.
      if (tokenRecord.auth_level === "account") {
        const accountTierResult = await handleAccountTierGet(
          req,
          res,
          db,
          tokenRecord,
          auditService,
        );
        if (accountTierResult.kind === "responded") return;
      }

      res.json({
        status: "valid",
        is_preview: tokenRecord.is_preview,
        sender_hint: await resolveSenderHint(db, tokenRecord),
        review: {
          id: result.review.id,
          payload: result.review.payload,
          priority: result.review.priority,
          actions: result.review.actions,
          template_slug: result.review.template_slug,
          created_at: result.review.created_at,
        },
        template: result.template
          ? {
              name: result.template.name,
              description: result.template.description,
              // Normalized like every other read path — otherwise this
              // endpoint emits a different field contract than the inbox:
              // an unenforced `readonly` key and an absent `editable`
              // instead of an explicit false.
              fields: normalizeTemplateFields(
                result.review.template_fields ?? result.template.fields,
              ),
              actions: normalizeTemplateActions(result.template.actions),
            }
          : null,
      });
    } catch (err) {
      next(err);
    }
  });

  const emailOtpDeps = {
    tokenService,
    otpStore,
    emailService,
    auditService,
    // Bound here rather than imported by the OTP module: that module is
    // imported by this one, so the reverse import would be a cycle.
    resolveSenderHint: (
      tokenRecord:
        | { created_by_kind?: string | null; created_by_id?: string | null }
        | null
        | undefined,
    ) => resolveSenderHint(db, tokenRecord),
  };

  // POST /r/:token/email-otp/request — handler body in token-reviews-email-otp.ts.
  router.post(
    "/:token/email-otp/request",
    tokenRateLimiter,
    makeEmailOtpRequestHandler(emailOtpDeps),
  );

  // POST /r/:token/email-otp/verify — handler body in token-reviews-email-otp.ts.
  router.post(
    "/:token/email-otp/verify",
    otpVerifyRateLimiter,
    makeEmailOtpVerifyHandler(emailOtpDeps),
  );

  // POST /r/:token/decide — execute a decision via token. When auth_level
  // is email_otp we gate on the recipient session cookie; when "account"
  // we gate on the main-app Bearer JWT via handleAccountTierDecidePreflight.
  // Both gates run BEFORE consume so a missing/invalid identity never
  // burns the token. Cookie is cleared on email_otp success.
  // validate() closes a gap: this legacy route had no body schema — it
  // destructured req.body raw, so `edited_payload` could be any JSON and
  // reached the JSONB column unchecked. Its canonical replacement
  // /:token/action has carried ReviewActionBodySchema all along.
  router.post("/:token/decide", tokenRateLimiter, validate({ body: ReviewDecideBodySchema }), async (req, res, next) => {
    try {
      const token = String(req.params.token);
      const { decision, feedback, edited_payload } = req.body;

      if (!decision) {
        throw new InvalidRequestError(
          "Missing required field: decision",
          "decision",
          "missing_required_fields",
        );
      }

      if (!token || !token.startsWith("gw_tok_")) {
        throw new InvalidRequestError("Invalid token format", "token", "invalid_token_format");
      }

      // Email-OTP gate must run BEFORE consume so a missing/invalid
      // session never burns the token. We re-validate to access
      // tokenRecord.auth_level + id without consuming.
      const validation = await tokenService.validate(token);
      if (!validation || validation.status !== "valid") {
        if (validation?.status === "used") {
          throw new GoneError("This review has already been decided.", "token_already_used");
        }
        if (validation?.status === "expired") {
          throw new GoneError("This review link has expired.", "token_expired");
        }
        if (validation?.status === "revoked") {
          throw new GoneError("This review link has been revoked.", "token_revoked");
        }
        throw new NotFoundError("This review link is invalid.", "token_invalid");
      }
      const preTokenRecord = validation.tokenRecord;
      // Preview links are for the sender to see their own page. They must
      // not be spendable: /action already refuses them, and the recipient UI
      // disables every control, but the client cannot be the only guard on a
      // public endpoint.
      if (preTokenRecord.is_preview) {
        throw new InvalidRequestError(
          "Preview tokens cannot be used to make decisions.",
          "token",
          "token_is_preview",
        );
      }

      let verifiedEmail: string | null = null;
      let accountSession: SessionResult | null = null;
      if (preTokenRecord.auth_level === "email_otp") {
        const cookieValue = req.cookies?.[recipientSessionCookieName(preTokenRecord.id)];
        const session = cookieValue
          ? verifyRecipientSession(cookieValue, preTokenRecord.id)
          : null;
        if (!session) {
          throw new AuthenticationError(
            "Please verify your email before deciding.",
            "email_otp_required",
          );
        }
        // session.email is the address verified at OTP-time; thread it
        // through so review_tokens.decided_by_email captures who actually
        // decided this. Discarding it here was a forensic-completeness
        // gap on token redesign §6.4 (decided_by_email is the authoritative
        // "who" for the decision).
        verifiedEmail = session.email;
      } else if (preTokenRecord.auth_level === "account") {
        // Identity preflight via helper — throws on missing/mismatch and
        // emits the decide-phase mismatch audit. Returning the resolved
        // session lets the post-consume stamp helper write
        // decided_by_user_id without re-validating.
        accountSession = await handleAccountTierDecidePreflight(
          req,
          db,
          preTokenRecord,
          auditService,
        );
      }

      const ip_address = req.ip || req.socket.remoteAddress || "unknown";
      const user_agent = req.get("User-Agent") || "unknown";

      // Preflight the review state BEFORE consuming the token row. Token
      // consume is a permanent (used_at, decision) stamp; if
      // executeReviewAction below rejects on a state-machine guard
      // (review already decided by the main app, expired, awaiting
      // changes), the consumed token row is unrecoverable on the
      // recipient side — recipient is locked out with no retry path,
      // token.consumed audit never fires (it's after the throw), and
      // any compensating revert risks leaving partial state. Re-reading
      // the review row first closes the common case (95%+ of races);
      // the catch-handler revert below handles the rare TOCTOU window
      // between this read and tokenService.consume.
      const [reviewPreRow] = await db
        .select({ status: reviewsTable.status })
        .from(reviewsTable)
        .where(eq(reviewsTable.id, preTokenRecord.review_id))
        .limit(1);
      if (!reviewPreRow) {
        throw new NotFoundError("This review link is invalid.", "token_invalid");
      }
      // executeReviewAction accepts pending or awaiting_external for
      // approve/reject; any other status is a state mismatch the action
      // service would throw on, but we surface it as a uniform decided/
      // expired error here so the recipient sees a clean message.
      if (
        reviewPreRow.status !== "pending" &&
        reviewPreRow.status !== "awaiting_external"
      ) {
        if (reviewPreRow.status === "decided") {
          throw new GoneError(
            "This review has already been decided.",
            "review_already_decided",
          );
        }
        if (reviewPreRow.status === "expired") {
          throw new GoneError("This review link has expired.", "review_expired");
        }
        throw new GatewerkError(
          "This review is not currently accepting decisions.",
          409,
          "validation",
          "review_state_invalid",
        );
      }

      const consumeResult = await tokenService.consume(token, {
        decision,
        ip_address,
        user_agent,
        feedback,
      });

      if (!consumeResult.success) {
        switch (consumeResult.error) {
          case "invalid":
            throw new NotFoundError("This review link is invalid.", "token_invalid");
          case "already_used":
            throw new GoneError("This review has already been decided.", "token_already_used");
          case "expired":
            throw new GoneError("This review link has expired.", "token_expired");
        }
      }

      const tokenRecord = consumeResult.tokenRecord!;

      // executeReviewAction handles wh.sendDecision (legacy compat) +
      // wh.sendActionTaken (canonical) and emits the review.decided
      // eventBus event for SSE consumers. Wrapped in a try/catch so a
      // post-preflight TOCTOU race (concurrent main-app reviewer
      // deciding between our preflight read and consume UPDATE) reverts
      // the token row instead of permanently burning it.
      const actionId = decision === "approved" ? "approve" : "reject";
      let updated;
      try {
        updated = await executeReviewAction({
          db,
          webhooks: wh,
          eventBus,
          auditService,
          reviewId: tokenRecord.review_id,
          projectId: tokenRecord.project_id,
          actor: externalDeciderActor(tokenRecord, { verifiedEmail, accountSession }),
          triggerPath: "token",
          actionId,
          feedback,
          editedPayload: edited_payload,
          requestId: req.requestId,
        });
      } catch (err) {
        // Compensating revert: undo the consume stamp so the recipient
        // can retry the decision (or, more typically, see the now-decided
        // state on the next page load). Best-effort: if the revert
        // itself fails the original error still propagates — recipient
        // sees the state-mismatch error and operator sees both audit
        // entries. Atomicity here is application-level rather than DB
        // transaction-level because executeReviewAction owns its own
        // transaction lifecycle and wrapping both in one outer txn
        // would defeat its compensation semantics.
        try {
          await db
            .update(reviewTokens)
            .set({
              used_at: null,
              decision: null,
              ip_address: null,
              user_agent: null,
            })
            .where(eq(reviewTokens.id, tokenRecord.id));
        } catch {
          // Swallow — original error is the truthful one to surface.
        }
        throw err;
      }

      // I1: stamp decided_by_email on the token row using the email
      // verified at OTP-time. Separate UPDATE rather than threading
      // through tokenService.consume to keep the consume signature
      // stable for non-OTP callers (chain-engine, public flow).
      if (verifiedEmail) {
        try {
          await db
            .update(reviewTokens)
            .set({ decided_by_email: verifiedEmail })
            .where(eq(reviewTokens.id, tokenRecord.id));
        } catch {
          // Best-effort — decided_by_email is forensic; failure to stamp
          // it must not invalidate a successful decision the recipient
          // has already seen succeed at the action layer.
        }
      }

      // Account-bound forensic stamp + audit. Same shape as the email_otp
      // decided_by_email pattern; helper owns the UPDATE + audit emit.
      if (accountSession) {
        await stampAccountTierDecided(
          req,
          db,
          tokenRecord.id,
          tokenRecord.review_id,
          tokenRecord.project_id,
          accountSession,
          auditService,
        );
      }

      // Token-specific audit on top of the action_taken audit emitted by
      // executeReviewAction.
      if (auditService) {
        auditService.log({
          action: "token.consumed",
          actor: `token:${tokenRecord.id}`,
          resource_type: "review",
          resource_id: tokenRecord.review_id,
          details: {
            decision,
            ip_address,
            user_agent,
            token_id: tokenRecord.id,
            // verified_email captured for double-belt forensics — the
            // token row carries it via decided_by_email; the audit
            // mirror lets ops correlate without joining tables.
            ...(verifiedEmail ? { verified_email: verifiedEmail } : {}),
          },
          project_id: tokenRecord.project_id,
        }).catch(() => {});
      }

      // Clear the recipient session cookie on success — it is bound to
      // a single token and the token is now consumed. Max-Age=0 plus the
      // matching path attribute is the RFC 6265 §5.3 form of cookie
      // expiry.
      if (preTokenRecord.auth_level === "email_otp") {
        // Match the path used at issuance (RFC 6265 §5.3) — clearCookie
        // with a different Path will not delete the live cookie.
        res.clearCookie(recipientSessionCookieName(preTokenRecord.id), { path: "/api/v1/r" });
      }

      res.set("Deprecation", "true");
      res.set("Sunset", "Wed, 01 Dec 2026 00:00:00 GMT");
      res.set("Link", `</api/v1/r/${token}/action>; rel="successor-version"`);
      res.json({
        status: "decided",
        decision: updated.decision,
        decided_at: updated.decided_at,
        message:
          decision === "approved"
            ? "Review approved successfully."
            : "Review rejected successfully.",
      });
    } catch (err) {
      next(err);
    }
  });

  // Canonical token-recipient action endpoint (Phase 7 — configurable actions).
  // Accepts any recipient-exposed decision action from the template via
  // POST /r/:token/action, replacing the hard-wired /decide shape. Held in
  // a sibling file so this orchestrator stays under the 600-line cap.
  router.use(
    createTokenActionRoutes({
      db,
      tokenService,
      auditService,
      eventBus,
      webhooks: wh,
      rateLimiter: tokenRateLimiter,
    }),
  );

  // Recipient-action endpoints (spec §7 E3 + E4 — Decline + Send-questions).
  // Mounted on the same /:token prefix as decide; each handler runs the
  // same auth gate (public passthrough / email_otp cookie / account JWT)
  // and emits a token-specific audit on top of the canonical token.consumed
  // pattern. Held in a sibling router file so this orchestrator stays under
  // the project's 600-line max-lines cap.
  router.use(
    createRecipientActionRoutes({
      db,
      tokenService,
      auditService,
      eventBus,
      webhooks: wh,
      rateLimiter: tokenRateLimiter,
    }),
  );

  return router;
}

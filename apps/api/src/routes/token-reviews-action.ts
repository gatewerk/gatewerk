import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Request } from "express";
import type rateLimit from "express-rate-limit";
import {
  AuthenticationError,
  GatewerkError,
  GoneError,
  InvalidRequestError,
  NotFoundError,
  ReviewActionBodySchema,
  normalizeTemplateActions,
} from "@gatewerk/shared";
import { reviewTokens, reviews as reviewsTable } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import type { createReviewTokenService } from "../services/review-tokens";
import type { createAuditService } from "../services/audit";
import type { EventBus } from "../services/events";
import type { WebhookService } from "../services/webhooks";
import { externalDeciderActor } from "../lib/external-decider";
import {
  recipientSessionCookieName,
  verifyRecipientSession,
} from "../services/token-recipient-session";
import { handleAccountTierDecidePreflight } from "./token-reviews-account-tier";
import { validate } from "../middleware/validate";
import { executeReviewAction } from "../services/reviews/execute-action";
import type { SessionResult } from "../lib/auth-helpers";

/**
 * POST /r/:token/action — the canonical token-recipient action endpoint.
 * Accepts any recipient-exposed decision action from the template, rather
 * than the hard-wired approve/reject of the legacy /r/:token/decide.
 *
 * Auth gate mirrors /r/:token/decide: public passthrough, email_otp cookie,
 * account JWT. expose_to_recipient filtering is enforced server-side after
 * token validation so a recipient cannot invoke an internal-only action.
 *
 * Kept in a sibling file so token-reviews.ts stays under the 600-line cap.
 */

type TokenService = ReturnType<typeof createReviewTokenService>;
type AuditService = ReturnType<typeof createAuditService>;

export interface TokenActionDeps {
  db: AppDb;
  tokenService: TokenService;
  auditService?: AuditService;
  eventBus?: EventBus;
  webhooks: WebhookService;
  rateLimiter: ReturnType<typeof rateLimit>;
}

// ---------------------------------------------------------------------------
// Auth helper — mirrors gateRecipientAuth in token-reviews-recipient-actions.ts.
// Controlled duplication: the /decide handler has its own inlined copy and
// touching it risks regressions on the legacy path. A shared utility will
// land in a later refactor once all recipient-action handlers are stable.
// ---------------------------------------------------------------------------

interface RecipientAuthResult {
  verifiedEmail: string | null;
  accountSession: SessionResult | null;
}

function assertNeverAuthLevel(x: never): never {
  throw new Error(`Unhandled auth_level in gateRecipientAuth: ${String(x)}`);
}

async function gateRecipientAuth(
  req: Request,
  preTokenRecord: {
    id: string;
    review_id: string;
    project_id: string;
    auth_level: string;
    auth_user_id: string | null;
  },
  db: AppDb,
  auditService: AuditService | undefined,
): Promise<RecipientAuthResult> {
  // Narrow the storage-CHECK-constrained string to the union the rest of
  // the code reasons on. migration 035 constrains the column to these
  // three values; any future tier addition lands a TS compile error at
  // assertNeverAuthLevel below.
  const authLevel = preTokenRecord.auth_level as
    | "public"
    | "email_otp"
    | "account";
  switch (authLevel) {
    case "public":
      return { verifiedEmail: null, accountSession: null };
    case "email_otp": {
      const cookieValue = req.cookies?.[recipientSessionCookieName(preTokenRecord.id)];
      const session = cookieValue
        ? verifyRecipientSession(cookieValue, preTokenRecord.id)
        : null;
      if (!session) {
        throw new AuthenticationError(
          "Please verify your email before continuing.",
          "email_otp_required",
        );
      }
      return { verifiedEmail: session.email, accountSession: null };
    }
    case "account": {
      const session = await handleAccountTierDecidePreflight(
        req,
        db,
        preTokenRecord,
        auditService,
      );
      return { verifiedEmail: null, accountSession: session };
    }
    default:
      return assertNeverAuthLevel(authLevel);
  }
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createTokenActionRoutes(deps: TokenActionDeps): Router {
  const router = Router();
  const { db, tokenService, auditService, eventBus, webhooks, rateLimiter } =
    deps;

  // POST /r/:token/action — execute a recipient-facing action via token.
  router.post(
    "/:token/action",
    rateLimiter,
    validate({ body: ReviewActionBodySchema }),
    async (req, res, next) => {
      try {
        const token = String(req.params.token);

        if (!token || !token.startsWith("gw_tok_")) {
          throw new InvalidRequestError(
            "Invalid token format",
            "token",
            "invalid_token_format",
          );
        }

        // Auth gate runs BEFORE consume so a missing/invalid identity never
        // burns the token. We re-validate to access tokenRecord.auth_level
        // without consuming.
        const validation = await tokenService.validate(token);
        if (!validation || validation.status !== "valid") {
          if (validation?.status === "used") {
            throw new GoneError(
              "This review has already been decided.",
              "token_already_used",
            );
          }
          if (validation?.status === "expired") {
            throw new GoneError(
              "This review link has expired.",
              "token_expired",
            );
          }
          if (validation?.status === "revoked") {
            throw new GoneError(
              "This review link has been revoked.",
              "token_revoked",
            );
          }
          throw new NotFoundError(
            "This review link is invalid.",
            "token_invalid",
          );
        }

        const preTokenRecord = validation.tokenRecord;

        if (preTokenRecord.is_preview) {
          throw new InvalidRequestError(
            "Preview tokens cannot be used to make decisions.",
            "token",
            "token_is_preview",
          );
        }

        const { verifiedEmail, accountSession } = await gateRecipientAuth(
          req,
          preTokenRecord,
          db,
          auditService,
        );

        // Validate that the requested action_id is a recipient-exposed
        // decision action. normalizeTemplateActions() handles legacy DB shapes.
        const { action_id, feedback, edited_payload, version } =
          ReviewActionBodySchema.parse(req.body);

        // validation.template is the template row fetched by tokenService.validate();
        // null when the review has no template (legacy/ad-hoc). Fall back to []
        // via normalizeTemplateActions so the action-not-available check below
        // correctly rejects the request rather than crashing.
        const templateActions = normalizeTemplateActions(
          validation.template?.actions,
        );
        const recipientAction = templateActions.find(
          (a) =>
            a.id === action_id &&
            a.kind === "decision" &&
            a.expose_to_recipient !== false,
        );

        if (!recipientAction) {
          throw new InvalidRequestError(
            "This action is not available for recipient use.",
            "action_id",
            "action_not_available",
          );
        }

        const ip_address = req.ip || req.socket.remoteAddress || "unknown";
        const user_agent = req.get("User-Agent") || "unknown";

        // Preflight the review state BEFORE consuming. Token consume is a
        // permanent stamp; if executeReviewAction rejects on a state-machine
        // guard the consumed token row is unrecoverable on the recipient side.
        const [reviewPreRow] = await db
          .select({ status: reviewsTable.status })
          .from(reviewsTable)
          .where(eq(reviewsTable.id, preTokenRecord.review_id))
          .limit(1);

        if (!reviewPreRow) {
          throw new NotFoundError(
            "This review link is invalid.",
            "token_invalid",
          );
        }

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
            throw new GoneError(
              "This review link has expired.",
              "review_expired",
            );
          }
          throw new GatewerkError(
            "This review is not currently accepting decisions.",
            409,
            "validation",
            "review_state_invalid",
          );
        }

        // The canonical decision value for this action (e.g. "approved" or a
        // custom decision_value). Falls back to action_id if no decision_value
        // is set (should not happen for a valid decision action, but keeps the
        // consume call safe).
        const decisionValue =
          recipientAction.decision_value ?? action_id;

        const consumeResult = await tokenService.consume(token, {
          decision: decisionValue,
          ip_address,
          user_agent,
          feedback,
        });

        if (!consumeResult.success) {
          switch (consumeResult.error) {
            case "invalid":
              throw new NotFoundError(
                "This review link is invalid.",
                "token_invalid",
              );
            case "already_used":
              throw new GoneError(
                "This review has already been decided.",
                "token_already_used",
              );
            case "expired":
              throw new GoneError(
                "This review link has expired.",
                "token_expired",
              );
          }
        }

        const tokenRecord = consumeResult.tokenRecord!;

        // executeReviewAction handles webhook dispatch + SSE eventBus emit.
        // Wrapped in try/catch so a post-preflight TOCTOU race reverts the
        // token row instead of permanently burning it.
        let updated;
        try {
          updated = await executeReviewAction({
            db,
            webhooks,
            eventBus,
            auditService,
            reviewId: tokenRecord.review_id,
            projectId: tokenRecord.project_id,
            actor: externalDeciderActor(tokenRecord, { verifiedEmail, accountSession }),
            triggerPath: "token",
            actionId: action_id,
            feedback,
            editedPayload: edited_payload,
            expectedVersion: version,
            requestId: req.requestId,
          });
        } catch (err) {
          // Compensating revert: undo the consume stamp so the recipient
          // can retry. Best-effort: if the revert itself fails the original
          // error still propagates.
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

        // Forensic stamp: decided_by_email (email_otp tier). Separate UPDATE
        // keeps the consume() signature stable for non-OTP callers.
        if (verifiedEmail) {
          try {
            await db
              .update(reviewTokens)
              .set({ decided_by_email: verifiedEmail })
              .where(eq(reviewTokens.id, tokenRecord.id));
          } catch {
            // Best-effort — forensic; failure must not fail the request.
          }
        }

        // Forensic stamp + audit: decided_by_user_id (account tier). Reuses
        // the stampAccountTierDecided pattern from /decide handler.
        if (accountSession) {
          try {
            await db
              .update(reviewTokens)
              .set({ decided_by_user_id: accountSession.id })
              .where(eq(reviewTokens.id, tokenRecord.id));
          } catch {
            // Best-effort.
          }
        }

        // Token-specific audit on top of any action_taken audit emitted by
        // executeReviewAction.
        if (auditService) {
          auditService
            .log({
              action: "token.action_taken",
              actor: `token:${tokenRecord.id}`,
              resource_type: "review",
              resource_id: tokenRecord.review_id,
              details: {
                action_id,
                decision: decisionValue,
                ip_address,
                user_agent,
                token_id: tokenRecord.id,
                ...(verifiedEmail ? { verified_email: verifiedEmail } : {}),
                ...(accountSession
                  ? { decided_by_user_id: accountSession.id }
                  : {}),
              },
              project_id: tokenRecord.project_id,
            })
            .catch(() => {});
        }

        // Clear the recipient session cookie on success (RFC 6265 §5.3).
        // Match the path used at issuance.
        if (preTokenRecord.auth_level === "email_otp") {
          res.clearCookie(recipientSessionCookieName(preTokenRecord.id), { path: "/api/v1/r" });
        }

        res.json({
          status: "decided",
          decision: updated.decision,
          decided_at: updated.decided_at,
          message: `Action '${action_id}' completed successfully.`,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type rateLimit from "express-rate-limit";
import {
  AuthenticationError,
  ConflictError,
  GoneError,
  InvalidRequestError,
  NotFoundError,
  generateId,
  type Priority,
} from "@gatewerk/shared";
import { notes, noteAttachments, projects } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import type { createReviewTokenService } from "../services/review-tokens";
import type { createAuditService } from "../services/audit";
import type { EventBus } from "../services/events";
import type { WebhookService } from "../services/webhooks";
import {
  recipientSessionCookieName,
  verifyRecipientSession,
} from "../services/token-recipient-session";
import { handleAccountTierDecidePreflight } from "./token-reviews-account-tier";
import { validate } from "../middleware/validate";
import type { SessionResult } from "../lib/auth-helpers";

/**
 * Recipient-action routes (token redesign §7 E3 + E4): Decline and
 * Send-questions. Both consume the token forensically (same auth gate +
 * decided_by_* stamp lifecycle as /decide) and revert the review to
 * `pending` so the reviewer can act again. Neither writes a decision.
 *
 * Extracted from routes/token-reviews.ts to keep that file under the
 * project's 600-line max-lines cap. Page-internal — kept under routes/
 * because the handlers operate on Express req/res, not domain logic.
 */

type TokenService = ReturnType<typeof createReviewTokenService>;
type AuditService = ReturnType<typeof createAuditService>;

interface RecipientActionDeps {
  db: AppDb;
  tokenService: TokenService;
  auditService?: AuditService;
  eventBus?: EventBus;
  webhooks?: WebhookService;
  rateLimiter: ReturnType<typeof rateLimit>;
}

/**
 * Cross-tier recipient-auth preflight. Mirrors the auth gate used by
 * /decide — public passes through, email_otp validates the recipient
 * session cookie, account validates the main-app Bearer JWT. Returns a
 * forensic-stamp tuple the caller writes onto the token row post-consume.
 *
 * Kept module-local because the /decide gate keeps its inlined version —
 * extracting that without touching its lifecycle was deemed riskier than
 * a controlled duplication for /decide vs a fresh helper here.
 */
interface RecipientAuthResult {
  verifiedEmail: string | null;
  accountSession: SessionResult | null;
}

function assertNeverAuthLevel(x: never): never {
  throw new Error(
    `Unhandled auth_level in gateRecipientAuth: ${String(x)}`,
  );
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

// Server schemas mirror the client-side input contract (spec §7.3): trim
// before validate so a whitespace-only decline_reason rejects as missing
// rather than persisting an empty string and a 10-space question_text
// fails the min-10 gate the same way the client counter does.
const DeclineBodySchema = z.object({
  decline_reason: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .optional()
    .nullable(),
});

const RaiseQuestionsBodySchema = z.object({
  question_text: z.string().trim().min(10).max(5000),
});

/**
 * Insert a recipient-authored note bound to the review via the canonical
 * Phase A notes layer (`notes` + `note_attachments`, see eslint-rules
 * /no-review-notes-imports.mjs). Recipients have no Gatewerk user
 * identity; `author_id` is null and the `author_display_fallback` carries
 * the `recipient:LABEL` surrogate. `note_attachments` binds the note to
 * the review (target_kind='review') so it surfaces alongside the review
 * per spec §7 E3+E4. Tagged `external` so downstream filters can
 * separate it from internal-team notes.
 */
async function insertRecipientReviewNote(
  tx: Parameters<Parameters<AppDb["transaction"]>[0]>[0],
  args: {
    projectId: string;
    reviewId: string;
    body: string;
    recipientLabel: string;
  },
): Promise<void> {
  const noteId = generateId("note");
  const attachmentId = generateId("pin");
  await tx.insert(notes).values({
    id: noteId,
    project_id: args.projectId,
    author_id: null,
    author_display_fallback: `recipient:${args.recipientLabel}`,
    body: args.body,
    tags: ["external"],
    is_shared: true,
  });
  await tx.insert(noteAttachments).values({
    id: attachmentId,
    note_id: noteId,
    target_kind: "review",
    target_id: args.reviewId,
    attached_by: null,
  });
}

function clearEmailOtpCookieIfPresent(
  authLevel: string,
  tokenId: string,
  res: Response,
): void {
  if (authLevel === "email_otp") {
    // RFC 6265 §5.3 — the clearCookie path attribute must match the
    // Set-Cookie path used at issuance or the browser silently retains
    // the cookie. Same path as the /decide handler clear.
    res.clearCookie(recipientSessionCookieName(tokenId), { path: "/api/v1/r" });
  }
}

/**
 * Best-effort audit-emit logger. Audit rows are the only forensic record
 * of decline / questions; if the insert fails (FK violation, pool
 * exhaustion, serialization conflict) ops loses the trail. Console.error
 * preserves observability without rejecting the recipient's request.
 */
function logAuditEmitFailure(
  action: string,
  tokenId: string,
  reviewId: string,
  err: unknown,
): void {
  console.error("[recipient-actions] audit emit failed", {
    action,
    token_id: tokenId,
    review_id: reviewId,
    err: err instanceof Error ? err.message : String(err),
  });
}

export function createRecipientActionRoutes(
  deps: RecipientActionDeps,
): Router {
  const router = Router();
  const { db, tokenService, auditService, rateLimiter, webhooks } = deps;

  // POST /r/:token/decline — recipient declines. Reverts review to pending
  // (NOT rejected — spec §7 E3 is explicit) + creates a decline note +
  // stamps the token decided_by_* field per tier + emits token.declined.
  router.post(
    "/:token/decline",
    rateLimiter,
    validate({ body: DeclineBodySchema }),
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

        const validation = await tokenService.validate(token);
        if (!validation || validation.status !== "valid") {
          if (validation?.status === "used") {
            throw new GoneError(
              "This review link has already been used.",
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

        const { verifiedEmail, accountSession } = await gateRecipientAuth(
          req,
          preTokenRecord,
          db,
          auditService,
        );

        const ip_address = req.ip || req.socket.remoteAddress || "unknown";
        const user_agent = req.get("User-Agent") || "unknown";
        const declineReason =
          (req.body as z.infer<typeof DeclineBodySchema>).decline_reason ?? null;
        const recipientLabel = preTokenRecord.recipient_label;
        const noteBody = declineReason
          ? `Declined by ${recipientLabel}: ${declineReason}`
          : `Declined by ${recipientLabel}`;

        const consumeResult = await tokenService.consumeAsRecipientAction(
          token,
          {
            kind: "declined",
            ip_address,
            user_agent,
            decided_by_email: verifiedEmail,
            decided_by_user_id: accountSession?.id ?? null,
            insertNote: async (tx, tokenRow) => {
              await insertRecipientReviewNote(tx, {
                projectId: tokenRow.project_id,
                reviewId: tokenRow.review_id,
                body: noteBody,
                recipientLabel: tokenRow.recipient_label,
              });
            },
          },
        );

        if (!consumeResult.success) {
          switch (consumeResult.error) {
            case "invalid":
              throw new NotFoundError(
                "This review link is invalid.",
                "token_invalid",
              );
            case "already_used":
              throw new GoneError(
                "This review link has already been used.",
                "token_already_used",
              );
            case "expired":
              throw new GoneError(
                "This review link has expired.",
                "token_expired",
              );
            case "review_already_decided":
              throw new ConflictError(
                "This review has already been decided.",
                "review_already_decided",
              );
          }
        }

        const tokenRecord = consumeResult.tokenRecord!;

        if (auditService) {
          auditService
            .log({
              action: "token.declined",
              actor: `token:${tokenRecord.id}`,
              resource_type: "review",
              resource_id: tokenRecord.review_id,
              details: {
                recipient_label: tokenRecord.recipient_label,
                auth_level: preTokenRecord.auth_level,
                ip_address,
                user_agent,
                token_id: tokenRecord.id,
                ...(declineReason ? { decline_reason: declineReason } : {}),
                ...(verifiedEmail ? { verified_email: verifiedEmail } : {}),
                ...(accountSession
                  ? { decided_by_user_id: accountSession.id }
                  : {}),
              },
              project_id: tokenRecord.project_id,
            })
            .catch((err) =>
              logAuditEmitFailure(
                "token.declined",
                tokenRecord.id,
                tokenRecord.review_id,
                err,
              ),
            );

          // Account-tier parity with /decide's stampAccountTierDecided —
          // ops queries filtering on action='token.account_decided' must
          // see declines + questions or they silently miss recipient
          // actions on account-bound tokens (spec §7.4 forensic
          // completeness).
          if (accountSession) {
            auditService
              .log({
                action: "token.account_decided",
                actor: `token:${tokenRecord.id}`,
                resource_type: "review",
                resource_id: tokenRecord.review_id,
                details: {
                  token_id: tokenRecord.id,
                  decided_by_user_id: accountSession.id,
                  action_kind: "declined",
                },
                project_id: tokenRecord.project_id,
              })
              .catch((err) =>
                logAuditEmitFailure(
                  "token.account_decided",
                  tokenRecord.id,
                  tokenRecord.review_id,
                  err,
                ),
              );
          }
        }

        clearEmailOtpCookieIfPresent(preTokenRecord.auth_level, preTokenRecord.id, res);

        // Observability (Plan 6 C1). Fire-and-forget: neither the eventBus
        // emit nor the webhook delivery must block the recipient's response.
        const revertedReview = consumeResult.reviewRecord!;
        const revertedAt = revertedReview.updated_at instanceof Date
          ? revertedReview.updated_at.toISOString()
          : new Date().toISOString();

        deps.eventBus?.emit("review.sent_back", {
          review_id: tokenRecord.review_id,
          template: revertedReview.template_slug,
          project_id: tokenRecord.project_id,
          priority: revertedReview.priority as Priority,
          created_at: revertedReview.created_at instanceof Date
            ? revertedReview.created_at.toISOString()
            : String(revertedReview.created_at),
          decline_reason: declineReason,
        });

        if (revertedReview.callback_url && webhooks) {
          db.select({ hmac_secret: projects.hmac_secret })
            .from(projects)
            .where(eq(projects.id, tokenRecord.project_id))
            .limit(1)
            .then(([proj]) => {
              if (!proj) {
                console.error(
                  "[recipient-actions] send-back webhook skipped: project not found",
                  { review_id: tokenRecord.review_id },
                );
                return;
              }
              webhooks.sendSentBack({
                callback_url: revertedReview.callback_url!,
                hmac_secret: proj.hmac_secret,
                review_id: tokenRecord.review_id,
                recipient_label: tokenRecord.recipient_label,
                decline_reason: declineReason,
                reverted_at: revertedAt,
                request_id: req.get("X-Request-Id"),
              }).catch((err) => {
                console.error("[recipient-actions] sendSentBack failed", {
                  review_id: tokenRecord.review_id,
                  err: err instanceof Error ? err.message : String(err),
                });
              });
            })
            .catch((err) =>
              console.error(
                "[recipient-actions] send-back webhook hmac lookup failed",
                {
                  review_id: tokenRecord.review_id,
                  err: err instanceof Error ? err.message : String(err),
                },
              ),
            );
        }

        res.json({
          status: "declined",
          message: "The review has been returned to the sender.",
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /r/:token/raise-questions — recipient sends back with questions.
  // Reverts review to pending + creates a question note + stamps the token
  // + emits token.questions_raised.
  router.post(
    "/:token/raise-questions",
    rateLimiter,
    validate({ body: RaiseQuestionsBodySchema }),
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

        const validation = await tokenService.validate(token);
        if (!validation || validation.status !== "valid") {
          if (validation?.status === "used") {
            throw new GoneError(
              "This review link has already been used.",
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

        const { verifiedEmail, accountSession } = await gateRecipientAuth(
          req,
          preTokenRecord,
          db,
          auditService,
        );

        const ip_address = req.ip || req.socket.remoteAddress || "unknown";
        const user_agent = req.get("User-Agent") || "unknown";
        const { question_text } = req.body as z.infer<
          typeof RaiseQuestionsBodySchema
        >;
        const recipientLabel = preTokenRecord.recipient_label;
        const noteBody = `${recipientLabel} asked: ${question_text}`;

        const consumeResult = await tokenService.consumeAsRecipientAction(
          token,
          {
            kind: "questions_raised",
            ip_address,
            user_agent,
            decided_by_email: verifiedEmail,
            decided_by_user_id: accountSession?.id ?? null,
            insertNote: async (tx, tokenRow) => {
              await insertRecipientReviewNote(tx, {
                projectId: tokenRow.project_id,
                reviewId: tokenRow.review_id,
                body: noteBody,
                recipientLabel: tokenRow.recipient_label,
              });
            },
          },
        );

        if (!consumeResult.success) {
          switch (consumeResult.error) {
            case "invalid":
              throw new NotFoundError(
                "This review link is invalid.",
                "token_invalid",
              );
            case "already_used":
              throw new GoneError(
                "This review link has already been used.",
                "token_already_used",
              );
            case "expired":
              throw new GoneError(
                "This review link has expired.",
                "token_expired",
              );
            case "review_already_decided":
              throw new ConflictError(
                "This review has already been decided.",
                "review_already_decided",
              );
          }
        }

        const tokenRecord = consumeResult.tokenRecord!;

        if (auditService) {
          auditService
            .log({
              action: "token.questions_raised",
              actor: `token:${tokenRecord.id}`,
              resource_type: "review",
              resource_id: tokenRecord.review_id,
              details: {
                recipient_label: tokenRecord.recipient_label,
                auth_level: preTokenRecord.auth_level,
                question_text,
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
            .catch((err) =>
              logAuditEmitFailure(
                "token.questions_raised",
                tokenRecord.id,
                tokenRecord.review_id,
                err,
              ),
            );

          if (accountSession) {
            auditService
              .log({
                action: "token.account_decided",
                actor: `token:${tokenRecord.id}`,
                resource_type: "review",
                resource_id: tokenRecord.review_id,
                details: {
                  token_id: tokenRecord.id,
                  decided_by_user_id: accountSession.id,
                  action_kind: "questions_raised",
                },
                project_id: tokenRecord.project_id,
              })
              .catch((err) =>
                logAuditEmitFailure(
                  "token.account_decided",
                  tokenRecord.id,
                  tokenRecord.review_id,
                  err,
                ),
              );
          }
        }

        clearEmailOtpCookieIfPresent(preTokenRecord.auth_level, preTokenRecord.id, res);

        // Observability (Plan 6 C1). Fire-and-forget: neither the eventBus
        // emit nor the webhook delivery must block the recipient's response.
        const revertedReview = consumeResult.reviewRecord!;
        const revertedAt = revertedReview.updated_at instanceof Date
          ? revertedReview.updated_at.toISOString()
          : new Date().toISOString();

        deps.eventBus?.emit("review.questions_raised", {
          review_id: tokenRecord.review_id,
          template: revertedReview.template_slug,
          project_id: tokenRecord.project_id,
          priority: revertedReview.priority as Priority,
          created_at: revertedReview.created_at instanceof Date
            ? revertedReview.created_at.toISOString()
            : String(revertedReview.created_at),
          question_text,
        });

        if (revertedReview.callback_url && webhooks) {
          db.select({ hmac_secret: projects.hmac_secret })
            .from(projects)
            .where(eq(projects.id, tokenRecord.project_id))
            .limit(1)
            .then(([proj]) => {
              if (!proj) {
                console.error(
                  "[recipient-actions] send-back webhook skipped: project not found",
                  { review_id: tokenRecord.review_id },
                );
                return;
              }
              webhooks.sendQuestionsRaised({
                callback_url: revertedReview.callback_url!,
                hmac_secret: proj.hmac_secret,
                review_id: tokenRecord.review_id,
                recipient_label: tokenRecord.recipient_label,
                question_text,
                reverted_at: revertedAt,
                request_id: req.get("X-Request-Id"),
              }).catch((err) => {
                console.error("[recipient-actions] sendQuestionsRaised failed", {
                  review_id: tokenRecord.review_id,
                  err: err instanceof Error ? err.message : String(err),
                });
              });
            })
            .catch((err) =>
              console.error(
                "[recipient-actions] send-back webhook hmac lookup failed",
                {
                  review_id: tokenRecord.review_id,
                  err: err instanceof Error ? err.message : String(err),
                },
              ),
            );
        }

        res.json({
          status: "questions_raised",
          message: "Your questions have been sent to the reviewer.",
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

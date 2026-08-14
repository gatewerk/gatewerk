import type { Request, Response, RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { reviews as reviewsTable } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import { ForbiddenError, InvalidRequestError } from "@gatewerk/shared";
import { createReviewTokenService } from "../services/review-tokens";
import { dualAuth } from "./dual-auth";
import { ServiceUnavailableError } from "../lib/http-errors";

/**
 * Entitlement gate for stored review media.
 *
 * Two mounts serve attachments and neither had any check: `/uploads`
 * (express.static, EVERY deployment including OSS) and, on cloud only,
 * `/api/v1/media/:reviewId/:filename`. Both hand out a file to anyone who can
 * name a review id. That id is the entire secret — a stored file is named
 * after its TEMPLATE field (`services/media.ts` storeBuffer writes
 * `${fieldName}${ext}`), so `receipt.jpg` needs no guessing at all — and
 * review ids travel in webhook bodies and email.
 *
 * Two principals legitimately read media, so this cannot simply require a
 * session:
 *
 *  - an operator, by session or project-scoped API key;
 *  - an external recipient holding a live review link, who has no account by
 *    design.
 *
 * The recipient's proof has to ride in the QUERY STRING. An `<img src>` cannot
 * attach an Authorization header, and the recipient session cookie is
 * deliberately scoped to `path: "/api/v1/r"` (see token-reviews-email-otp.ts),
 * so RFC 6265 path-matching means the browser never sends it here. The param
 * is named `token` precisely because middleware/logging.ts SENSITIVE_PARAMS
 * already redacts `token=` from access logs.
 *
 * A token in a URL is still weaker than a header: it reaches browser history
 * and any Referer sent from the page. That is the accepted cost of letting an
 * accountless recipient see an attachment at all, and it is bounded by the
 * token's own expiry and revocability.
 */
export function requireMediaAccess(db: AppDb): RequestHandler {
  const tokenService = createReviewTokenService(db);
  const auth = dualAuth(db);

  return async (req, res, next) => {
    const reviewId = mediaReviewId(req);
    if (!reviewId) {
      return res
        .status(400)
        .json(new InvalidRequestError("Media path carries no review id").toJSON());
    }

    const raw = typeof req.query.token === "string" ? req.query.token : undefined;
    if (raw) {
      const validation = await tokenService.validate(raw);
      if (!validation || validation.status !== "valid") {
        // Revoked, spent, expired and never-issued all collapse to one
        // refusal: the holder of a dead link learns nothing about which.
        return denyMedia(req, res, reviewId, `token_${validation?.status ?? "unknown"}`);
      }
      if (validation.tokenRecord.review_id !== reviewId) {
        // The reason this gate exists: a link for review A must never read
        // review B's attachments.
        return denyMedia(req, res, reviewId, "token_for_other_review");
      }
      return next();
    }

    // Operator path. dualAuth resolves API key or session exactly as every
    // /api/v1 route does; its AuthenticationError becomes a 401 downstream,
    // which is the right answer for a request carrying no credential at all.
    try {
      await new Promise<void>((resolve, reject) => {
        auth(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      return next(err);
    }

    // An API key is pinned to one project, so it may only read that project's
    // media. A session sets no projectId and is trusted across projects, which
    // is the same latitude lib/resolve-project-id.ts already grants session
    // callers on every review route — this gate deliberately does not invent a
    // stricter rule than the routes it protects.
    const projectId = (req as unknown as { projectId?: string }).projectId;
    if (projectId) {
      const [review] = await db
        .select({ project_id: reviewsTable.project_id })
        .from(reviewsTable)
        .where(eq(reviewsTable.id, reviewId))
        .limit(1);
      if (!review || review.project_id !== projectId) {
        return denyMedia(req, res, reviewId, "wrong_project");
      }
    }

    return next();
  };
}

/**
 * Guard for an app built without a database. Authorization is impossible, so
 * the answer is no — the previous behaviour (serve it anyway) is the bug.
 */
export const mediaUnavailable: RequestHandler = (_req, res) => {
  res.status(503).json(
    new ServiceUnavailableError("Media cannot be authorized without a database", "media_unavailable").toJSON(),
  );
};

/**
 * `/api/v1/media/:reviewId/:filename` supplies req.params.reviewId. The
 * `/uploads` mount does not: express strips the mount path, leaving req.path
 * as `/<reviewId>/<filename>`.
 */
function mediaReviewId(req: Request): string | null {
  const fromParams = (req.params as Record<string, unknown> | undefined)?.reviewId;
  if (typeof fromParams === "string" && fromParams) return fromParams;
  const [first] = req.path.split("/").filter(Boolean);
  return first ?? null;
}

function denyMedia(req: Request, res: Response, reviewId: string, reason: string): Response {
  console.warn("media.deny", {
    request_id: (req as unknown as { requestId?: string }).requestId,
    review_id: reviewId,
    reason,
  });
  return res.status(403).json(new ForbiddenError("Not entitled to this media", "media_forbidden").toJSON());
}

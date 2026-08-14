import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { templates as templatesTable } from "@gatewerk/db/src/schema/index";
import {
  envelope,
  InvalidRequestError,
  NotFoundError,
  ConflictError,
  normalizeTemplateActions,
} from "@gatewerk/shared";
import { requireScope } from "../../middleware/require-scope";
import { validate } from "../../middleware/validate";
import { resolveProjectId } from "../../lib/resolve-project-id";
import type { ReviewRouteDeps } from "./_deps";

// Local body schema — extends @gatewerk/shared's ReviewTokenBodySchema with
// accountability metadata + auth tier. Cross-field invariants (mirrors
// client-side applyAuthLevelChange in
// apps/web/src/pages/inbox/share-via-link-state.ts) run inside the
// validate({body}) middleware so callers get 422 validation_failed with
// field-level details before any DB lookup. Server enforces independent of
// client diligence so a hand-rolled API caller (curl, SDK, MCP) cannot
// persist a (auth_level, auth_email, auth_user_id) tuple that violates
// the contract.
const ReviewTokenBodySchema = z
  .object({
    purpose: z.string().max(80).optional().default(""),
    recipient_label: z.string().min(1).max(200),
    note: z.string().max(1000).optional().nullable(),
    auth_level: z.enum(["public", "email_otp", "account"]).optional().default("public"),
    auth_email: z.email().max(254).optional().nullable(),
    auth_user_id: z.string().max(64).optional().nullable(),
    expiryHours: z.number().int().min(1).max(720).optional(),
    preview: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.auth_level === "public" && val.auth_email) {
      ctx.addIssue({
        code: "custom",
        path: ["auth_email"],
        message: "auth_email must be null when auth_level is public",
        params: { code: "auth_level.contextual_fields_not_allowed_for_public" },
      });
    }
    if (val.auth_level === "public" && val.auth_user_id) {
      ctx.addIssue({
        code: "custom",
        path: ["auth_user_id"],
        message: "auth_user_id must be null when auth_level is public",
        params: { code: "auth_level.contextual_fields_not_allowed_for_public" },
      });
    }
    if (val.auth_level === "email_otp" && !val.auth_email) {
      ctx.addIssue({
        code: "custom",
        path: ["auth_email"],
        message: "auth_email required when auth_level is email_otp",
        params: { code: "auth_level.email_required" },
      });
    }
    if (val.auth_level === "email_otp" && val.auth_user_id) {
      ctx.addIssue({
        code: "custom",
        path: ["auth_user_id"],
        message: "auth_user_id must be null when auth_level is email_otp",
        params: { code: "auth_level.user_id_not_allowed_for_email_otp" },
      });
    }
    if (val.auth_level === "account" && !val.auth_user_id) {
      ctx.addIssue({
        code: "custom",
        path: ["auth_user_id"],
        message: "auth_user_id required when auth_level is account",
        params: { code: "auth_level.user_id_required" },
      });
    }
    if (val.auth_level === "account" && val.auth_email) {
      ctx.addIssue({
        code: "custom",
        path: ["auth_email"],
        message: "auth_email must be null when auth_level is account",
        params: { code: "auth_level.email_not_allowed_for_account" },
      });
    }
  });

const RevokeReviewTokenBodySchema = z.object({
  reason: z.string().max(500).optional(),
});

// Share-modal manage mode: +24h / +7d / +30d chips. Same 720h ceiling as
// the create endpoint's expiryHours.
const ExtendReviewTokenBodySchema = z.object({
  hours: z.number().int().min(1).max(720),
});

// Token-history-panel (spec §8.3). Pagination shape mirrors GET /reviews —
// the underlying composite index review_tokens(review_id, created_at DESC)
// supports the order + window without a sort step.
const ListReviewTokensQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export function createReviewTokenRoutes(deps: ReviewRouteDeps): Router {
  const router = Router();
  const { db, service, tokenService, auditService, emailService } = deps;

  // GET /api/v1/reviews/:id/tokens — list token history for a review.
  // Token-history-panel spec §3 + §5: read-only projection over
  // review_tokens, newest-first, paginated.
  router.get(
    "/:id/tokens",
    requireScope("reviews:read"),
    validate({ query: ListReviewTokensQuerySchema }),
    async (req, res, next) => {
      try {
        const projectId = await resolveProjectId(req, db, String(req.params.id));
        if (!projectId) {
          throw new NotFoundError("Review not found", "review_not_found");
        }
        const { limit, offset } = req.query as unknown as {
          limit: number;
          offset: number;
        };
        const result = await tokenService.listTokensForReview(
          projectId,
          String(req.params.id),
          { limit, offset },
        );
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/v1/reviews/:id/token — generate a review link token. The
  // ReviewTokenBodySchema superRefine above enforces cross-field invariants
  // for all three tiers; storage + recipient-side enforcement ships in
  // Phase 3 (email_otp + account flows). Defense-in-depth at the schema
  // layer + handler-level null-out (below) is the contract surface.
  router.post("/:id/token", requireScope("reviews:read"), validate({ body: ReviewTokenBodySchema }), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db, String(req.params.id));
      if (!projectId) {
        throw new NotFoundError("Review not found", "review_not_found");
      }

      const review = await service.getById(projectId, String(req.params.id));
      if (!review) {
        throw new NotFoundError("Review not found", "review_not_found");
      }

      if (review.status === "monitoring") {
        // Deliberate FORBID (spec §4.7): the external page would render a
        // fake please-approve card for an already-executed action, and the
        // status flip to awaiting_external would disarm the veto worker.
        throw new ConflictError(
          "Monitoring reviews cannot be shared with external recipients.",
          "monitoring_not_shareable",
        );
      }

      if (review.status !== "pending") {
        // Preview tokens are exempt from awaiting_external (mirrors the
        // service-level guard): they never transition the review, cannot
        // act, and are excluded from active-token selection.
        const previewFromExternal =
          ((req.body as { preview?: boolean }).preview ?? false) &&
          review.status === "awaiting_external";
        if (!previewFromExternal) {
          throw new InvalidRequestError(
            "Cannot generate token for a review that is not pending",
            "status",
            "review_not_pending",
          );
        }
      }

      if (!review.template_id) {
        throw new InvalidRequestError(
          "Review has no associated template. Review links require a template.",
          "template_id",
          "review_links_disabled",
        );
      }

      // Check template has review links enabled
      const [tpl] = await db
        .select({
          enable_review_links: templatesTable.enable_review_links,
          actions: templatesTable.actions,
        })
        .from(templatesTable)
        .where(eq(templatesTable.id, review.template_id))
        .limit(1);

      if (!tpl || !tpl.enable_review_links) {
        throw new InvalidRequestError(
          "Review links are not enabled for this template. Set enable_review_links to true on the template.",
          "template",
          "review_links_disabled",
        );
      }

      // SMTP guard (lifecycle map §11.5): an email_otp token whose OTP mail can
      // never send strands the recipient at "Code sent" (anti-enumeration hides
      // the failure). Refuse to create what cannot verify. Absence of the
      // emailService dep counts as unconfigured (default-deny).
      const wantsEmailOtp = (req.body as { auth_level?: string }).auth_level === "email_otp";
      if (wantsEmailOtp && !emailService?.isEmailConfigured()) {
        throw new ConflictError(
          "Email OTP links require email sending to be configured. Set SMTP_FROM and the SMTP_* variables in your environment and restart the API, or use a public or account link.",
          "smtp_not_configured",
        );
      }

      // Dead-link guard: issuing a link moves the review to awaiting_external,
      // so a template whose decision actions are not enabled for that status
      // produces a link nobody can act on. The recipient discovers this only
      // after clicking a button, as "Action 'approve' cannot be invoked on a
      // review with status 'awaiting_external'". Refuse at creation, where the
      // author can still fix the template. Preview links are exempt: they never
      // flip the status and are never spendable.
      const wantsPreview = ((req.body as { preview?: boolean }).preview ?? false);
      if (!wantsPreview) {
        const canonicalActions = normalizeTemplateActions(tpl.actions ?? []);
        const recipientCanDecide = canonicalActions.some(
          (a) =>
            a.kind === "decision" &&
            a.expose_to_recipient !== false &&
            (a.enabled_for_status === undefined ||
              a.enabled_for_status.includes("awaiting_external")),
        );
        if (!recipientCanDecide) {
          throw new ConflictError(
            "This template has no decision action available to a link recipient. Add \"awaiting_external\" to enabled_for_status on an approve or reject action, or clear enabled_for_status so it applies to every status.",
            "no_recipient_action",
          );
        }
      }

      const body = req.body as z.infer<typeof ReviewTokenBodySchema>;

      // Server-derive accountability fields from the auth context. Never trust
      // client input for created_by_kind / created_by_id. Session path
      // (manual creation from Inbox UI) is wired up in Phase 2; in C1 the
      // route is exercised by API-key callers only, so the apikey branch
      // is the load-bearing one.
      const authType = (req as any).authType as string | undefined;
      const apiKeyId = (req as any).apiKeyId as string | undefined;
      const reviewer = (req as any).reviewer as { id?: string; email?: string } | undefined;
      const created_by_kind: "manual" | "agent" =
        authType === "session" ? "manual" : "agent";
      const created_by_id =
        authType === "session"
          ? reviewer?.id ?? reviewer?.email ?? "unknown"
          : apiKeyId ?? "unknown";

      // Defense-in-depth (handler-level null-out): even though the schema
      // superRefine catches contextual-field misalignment, we explicitly
      // null-out fields not relevant to the chosen tier before persistence.
      // Guards against a future schema relaxation accidentally re-opening
      // the cross-field gap. See ReviewTokenBodySchema's superRefine for
      // the matching client-side rule mirror.
      const persistedAuthEmail =
        body.auth_level === "email_otp" ? body.auth_email ?? null : null;
      const persistedAuthUserId =
        body.auth_level === "account" ? body.auth_user_id ?? null : null;

      // False positive: tokenService.generate() is a local DB insert, not wkhtmltopdf's phantom method.
      const result = await tokenService.generate({ // nosemgrep: javascript.express.security.express-wkhtml-injection.express-wkhtmltoimage-injection
        review_id: review.id,
        project_id: projectId,
        purpose: body.purpose,
        recipient_label: body.recipient_label,
        note: body.note ?? null,
        auth_level: body.auth_level,
        auth_email: persistedAuthEmail,
        auth_user_id: persistedAuthUserId,
        created_by_kind,
        created_by_id,
        expiryHours: body.expiryHours,
        is_preview: body.preview ?? false,
      });

      // Audit log
      if (auditService) {
        const actor = (req as any).authType === "session"
          ? `reviewer:${(req as any).reviewer?.email}`
          : `agent:${(req as any).apiKeyPrefix || "unknown"}`;
        auditService.log({
          action: "token.created",
          actor,
          resource_type: "review",
          resource_id: review.id,
          details: {
            token_id: result.tokenRecord.id,
            expires_at: result.tokenRecord.expires_at,
          },
          project_id: projectId,
        }).catch(() => {});
      }

      res.status(201).json(envelope("review_token", {
        token: result.rawToken,
        review_id: review.id,
        expires_at: result.tokenRecord.expires_at,
        url: `/r/${result.rawToken}`,
      }));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/reviews/:id/token/revoke — revoke the active review-link
  // token, reverting the review to pending. Token-redesign Phase 1 spec §4.4.
  router.post(
    "/:id/token/revoke",
    requireScope("reviews:decide"),
    validate({ body: RevokeReviewTokenBodySchema }),
    async (req, res, next) => {
      try {
        const projectId = await resolveProjectId(req, db, String(req.params.id));
        if (!projectId) {
          throw new NotFoundError("Review not found", "review_not_found");
        }

        const review = await service.getById(projectId, String(req.params.id));
        if (!review) {
          throw new NotFoundError("Review not found", "review_not_found");
        }

        const body = req.body as z.infer<typeof RevokeReviewTokenBodySchema>;

        // Server-derive revoked_by from auth context (mirrors the create
        // endpoint's accountability-derivation pattern).
        const authType = (req as any).authType as string | undefined;
        const apiKeyId = (req as any).apiKeyId as string | undefined;
        const reviewer = (req as any).reviewer as { id?: string; email?: string } | undefined;
        const revoked_by =
          authType === "session"
            ? reviewer?.id ?? reviewer?.email ?? "unknown"
            : apiKeyId ?? "unknown";

        const result = await tokenService.revoke({
          review_id: review.id,
          revoked_by,
          reason: body.reason ?? null,
        });

        if (!result.success) {
          throw new NotFoundError("No active token for this review", "no_active_token");
        }

        if (auditService) {
          const actor =
            authType === "session"
              ? `reviewer:${reviewer?.email ?? "unknown"}`
              : `agent:${(req as any).apiKeyPrefix || "unknown"}`;
          const details: Record<string, unknown> = {
            token_id: result.revokedTokenId,
          };
          if (result.reason !== null) {
            details.reason = result.reason;
          }
          auditService.log({
            action: "token.revoked",
            actor,
            resource_type: "review",
            resource_id: review.id,
            details,
            project_id: projectId,
          }).catch(() => {});
        }

        res.json({ success: true });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/v1/reviews/:id/token/extend — push the active token's expiry
  // out by N hours (share-modal manage mode). Mirrors the revoke handler's
  // shape; extending a used/revoked/expired/preview token 404s — an expired
  // link must be re-generated, never resurrected.
  router.post(
    "/:id/token/extend",
    requireScope("reviews:decide"),
    validate({ body: ExtendReviewTokenBodySchema }),
    async (req, res, next) => {
      try {
        const projectId = await resolveProjectId(req, db, String(req.params.id));
        if (!projectId) {
          throw new NotFoundError("Review not found", "review_not_found");
        }

        const review = await service.getById(projectId, String(req.params.id));
        if (!review) {
          throw new NotFoundError("Review not found", "review_not_found");
        }

        const body = req.body as z.infer<typeof ExtendReviewTokenBodySchema>;

        const result = await tokenService.extend({
          review_id: review.id,
          hours: body.hours,
        });

        if (!result.success) {
          throw new NotFoundError("No active token for this review", "no_active_token");
        }

        if (auditService) {
          const authType = (req as any).authType as string | undefined;
          const reviewer = (req as any).reviewer as { email?: string } | undefined;
          const actor =
            authType === "session"
              ? `reviewer:${reviewer?.email ?? "unknown"}`
              : `agent:${(req as any).apiKeyPrefix || "unknown"}`;
          auditService.log({
            action: "token.extended",
            actor,
            resource_type: "review",
            resource_id: review.id,
            details: {
              token_id: result.tokenId,
              hours: body.hours,
              new_expires_at: result.expires_at.toISOString(),
            },
            project_id: projectId,
          }).catch(() => {});
        }

        res.json({ success: true, expires_at: result.expires_at.toISOString() });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

import { Router } from "express";
import {
  envelope,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  ReviewActionBodySchema,
} from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import type { AuditService } from "../../services/audit";
import { executeReviewAction } from "../../services/reviews/execute-action";
import { validate } from "../../middleware/validate";
import { requireScope } from "../../middleware/require-scope";
import { rateLimitByKey } from "../../middleware/rate-limit-key";
import { resolveProjectId } from "../../lib/resolve-project-id";
import { reviewPayload } from "./_helpers";
import type { ReviewRouteDeps } from "./_deps";
import {
  buildChainAwareSubject,
  can,
  subjectFromRequest,
  type Subject,
} from "../../policy";

// Mirror of decide.ts assertChainStepAllows — chain-attached reviews require
// the requester to match the step assignee, be the chain owner, or be a
// session admin. When the gate is cleared via admin or owner bypass, fires a
// fire-and-forget chain.admin_bypass audit entry for ops observability.
async function assertChainStepAllows(
  db: AppDb,
  req: unknown,
  reviewId: string,
  projectId: string,
  auditService?: AuditService,
): Promise<void> {
  const requester = subjectFromRequest(req);
  if (!requester) {
    throw new AuthenticationError("Authentication required");
  }
  const subject: Subject = await buildChainAwareSubject(db, reviewId, requester);
  if (subject.kind !== "chain_step") return;
  const decision = can(subject, ["reviews:decide"]);
  if (!decision.allow) {
    throw new ForbiddenError(
      `Not authorized for chain step ${subject.step_index}`,
      "chain_step_not_authorized",
    );
  }
  if (decision.bypass && auditService) {
    const actor = requester.kind === "session"
      ? `reviewer:${(requester as { email?: string }).email ?? (requester as { userId: string }).userId}`
      : `agent:${(requester as { projectId: string }).projectId}`;
    auditService.log({
      action: "chain.admin_bypass",
      actor,
      resource_type: "review",
      resource_id: reviewId,
      project_id: projectId,
      details: {
        bypass_kind: decision.bypass,
        chain_run_id: subject.chain_run_id,
        step_index: subject.step_index,
      },
    }).catch(() => {});
  }
}

// Configurable-actions primitive route (spec §3.1, §14 Phase 2 commit 2).
// The route's job: gate auth + chain-step, build the actor + trigger context,
// then delegate the load+normalize+invoke+persist+emit pipeline to
// executeReviewAction. The legacy /decide /retry /cancel-request aliases
// (routes/reviews/decide.ts) call the same helper with different action_id
// derivations and additional legacy-audit dual-fire — single state-machine
// source of truth across all four routes.
export function createReviewActionRoutes(deps: ReviewRouteDeps): Router {
  const router = Router();
  const { db, eventBus, auditService, webhooks: wh } = deps;

  // POST /api/v1/reviews/:id/action — invoke a configurable action
  router.post(
    "/:id/action",
    requireScope("reviews:decide"),
    rateLimitByKey(),
    validate({ body: ReviewActionBodySchema }),
    async (req, res, next) => {
      try {
        const reviewId = String(req.params.id);
        const { action_id, feedback, edited_payload, version } = req.body;

        // Phase 7: accept both session auth (reviewer) and api-key auth (agent).
        // requireScope("reviews:decide") above passes both auth types — we branch
        // here to build the correct actor shape for each path.
        const authType = (req as any).authType as string | undefined;
        const reviewer = (req as any).reviewer as { email?: string; name?: string } | undefined;
        const apiKeyPrefix = (req as any).apiKeyPrefix as string | undefined;

        let actor: Parameters<typeof executeReviewAction>[0]["actor"];
        let triggerPath: Parameters<typeof executeReviewAction>[0]["triggerPath"];

        if (authType === "session" && reviewer?.email) {
          actor = { kind: "reviewer", id: reviewer.email, email: reviewer.email };
          triggerPath = "manual";
        } else if (authType === "apikey" && apiKeyPrefix) {
          actor = { kind: "agent", id: apiKeyPrefix };
          triggerPath = "agent";
        } else {
          throw new AuthenticationError(
            "POST /reviews/:id/action requires a reviewer session or an API key.",
          );
        }

        const projectId = await resolveProjectId(req, db, reviewId);
        if (!projectId) {
          throw new NotFoundError("Review not found", "review_not_found");
        }

        await assertChainStepAllows(db, req, reviewId, projectId, auditService);

        const updated = await executeReviewAction({
          db,
          webhooks: wh,
          eventBus,
          auditService,
          reviewId,
          projectId,
          actor,
          triggerPath,
          actionId: action_id,
          feedback,
          editedPayload: edited_payload,
          expectedVersion: version,
          requestId: req.requestId,
        });

        res.json(envelope("review", { ...reviewPayload(updated), iteration_count: updated.current_version - 1 }));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

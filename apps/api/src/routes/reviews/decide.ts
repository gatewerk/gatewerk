import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { reviews as reviewsTable } from "@gatewerk/db/src/schema/index";
import {
  envelope,
  NotFoundError,
  AuthenticationError,
  ForbiddenError,
  ConflictError,
  InvalidRequestError,
  ReviewDecideBodySchema,
  ReviewRetryBodySchema,
  ReviewDraftBodySchema,
} from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import type { AuditService } from "../../services/audit";
import { executeReviewAction } from "../../services/reviews/execute-action";
import type { ActionActor } from "../../services/reviews/actions";
import type { TemplateActionConfig } from "@gatewerk/shared";
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

// Sunset target for legacy /decide /retry /cancel-request endpoints. v2.0
// removes them per spec §11.3. RFC 8594 Sunset header format.
const LEGACY_SUNSET_DATE = "Wed, 01 Dec 2026 00:00:00 GMT";

// Chain-aware policy gate (M11). For chain-attached reviews, decide / retry /
// cancel-request all require the requester to match the step assignee, be the
// chain owner, or a session admin. When the gate is cleared via admin or owner
// bypass, fires a fire-and-forget chain.admin_bypass audit entry (Task 3).
async function assertChainStepAllows(
  db: AppDb,
  req: unknown,
  reviewId: string,
  projectId: string,
  scope: "reviews:decide",
  auditService?: AuditService,
): Promise<void> {
  const requester = subjectFromRequest(req);
  if (!requester) {
    throw new AuthenticationError("Authentication required");
  }
  const subject: Subject = await buildChainAwareSubject(db, reviewId, requester);
  if (subject.kind !== "chain_step") return;
  const decision = can(subject, [scope]);
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

// Build the actor field for executeReviewAction from the legacy auth shape.
// /decide accepts both session and api-key.
//
// The body's optional `reviewer` field USED TO override the session email here
// (documented as a legacy SDK escape hatch). It no longer does, because the
// consequence was that an authenticated user could POST
// {"decision":"approved","reviewer":"someone.else@customer.com"} and the
// tamper-evident chain would sign a decision attributed to a person who did not
// make it — and verify() would return valid, because the row was never tampered
// with. It was fed a lie at the input. For a product whose claim is that the
// record cannot be forged, that is the one hole that matters.
//
// Removing it is far cheaper than it looks: the override was only ever read on
// THIS branch. An SDK consumer authenticating with an API key never reached it
// (see the api-key path below, which derives the actor from the key prefix), so
// the change is confined to session callers passing `reviewer` in the body.
// Their attested value is not discarded — it is recorded as
// details.attested_reviewer alongside the authenticated actor, so the caller's
// stated intent survives without the chain vouching for it.
function buildLegacyActor(req: unknown): ActionActor {
  const r = req as {
    authType?: string;
    reviewer?: { email?: string };
    apiKeyPrefix?: string;
  };
  if (r.authType === "session") {
    const email = r.reviewer?.email || "unknown";
    return { kind: "reviewer", id: email, email };
  }
  // API-key path. action service emits trigger_path="manual" because the
  // legacy aliases were never invoked from chain/token contexts; agent-driven
  // workflows use POST /api/v1/reviews to create reviews, then a reviewer
  // resolves them.
  const prefix = r.apiKeyPrefix || "unknown";
  return { kind: "agent", id: prefix };
}

// Set RFC 8594 deprecation headers on legacy responses. Successor link
// points at the new /action endpoint; sunset date is LEGACY_SUNSET_DATE
// above (v2.0 removes the legacy endpoints).
function setDeprecationHeaders(res: { set: (name: string, value: string) => unknown }, reviewId: string): void {
  res.set("Deprecation", "true");
  res.set("Sunset", LEGACY_SUNSET_DATE);
  res.set("Link", `</api/v1/reviews/${reviewId}/action>; rel="successor-version"`);
}

// Decide family: legacy /decide /retry /cancel-request aliases over
// invokeAction (Phase 3 of configurable-actions, spec §14 Phase 3 commit 1).
// Plus draft-save / draft-discard which cohabit this module because they
// represent WIP state of a decide action. Each alias calls executeReviewAction
// (single state-machine source of truth) and dual-fires the legacy audit
// event for one-minor-version backwards compat per spec §4.5 + §11.2.
export function createReviewDecideRoutes(deps: ReviewRouteDeps): Router {
  const router = Router();
  const { db, auditService } = deps;

  // POST /api/v1/reviews/:id/decide — DEPRECATED alias for POST /action with
  // action_id=approve|reject (depending on body.decision).
  router.post(
    "/:id/decide",
    requireScope("reviews:decide"),
    rateLimitByKey(),
    validate({ body: ReviewDecideBodySchema }),
    async (req, res, next) => {
      try {
        const reviewId = String(req.params.id);
        const projectId = await resolveProjectId(req, db, reviewId);
        if (!projectId) {
          throw new NotFoundError("Review not found", "review_not_found");
        }

        await assertChainStepAllows(db, req, reviewId, projectId, "reviews:decide", auditService);

        const { decision, feedback, edited_payload, prompt_edit, version, action_value, action_label, reviewer } = req.body;
        const actor = buildLegacyActor(req);

        // A session caller who supplied a `reviewer` that is not their own
        // authenticated identity. Recorded on the audit row rather than
        // honoured — see buildLegacyActor. Undefined when absent or when it
        // simply restates who they already are, so the field only ever appears
        // when there is a divergence worth an auditor's attention.
        const attestedReviewer =
          actor.kind === "reviewer" && reviewer && reviewer !== actor.id
            ? reviewer
            : undefined;

        // Monitoring outcomes are not legacy decisions. Without this guard
        // the alias's non-rejected→approve mapping (below) would turn
        // decision:'vetoed' into a silent APPROVE — the exact dishonesty the
        // monitoring gate exists to kill.
        if (decision === "confirmed" || decision === "vetoed") {
          throw new InvalidRequestError(
            "confirmed and vetoed are monitoring outcomes. Use POST /reviews/:id/veto or /reviews/:id/confirm.",
            "decision",
            "use_monitoring_endpoints",
          );
        }

        // Map legacy decision → action_id. Legacy /decide accepts any value
        // from the DECISIONS enum (approved, rejected, edited, retried,
        // expired). For backwards compat:
        //   - "approved"           → action_id="approve",  decision unchanged
        //   - "edited"             → action_id="approve",  decision="edited"
        //                            (legacy semantic: approve with edits)
        //   - "rejected" / other   → action_id="reject"
        const actionId = decision === "rejected" ? "reject" : "approve";

        // Legacy semantic override: legacy /decide accepted decision='rejected'
        // without feedback, but the canonical REJECT preset has
        // requires_feedback=true. Prepend a no-requires-feedback override so
        // existing SDK consumers don't break. The /action endpoint and
        // template-authored reject actions retain the strict semantic.
        const legacyOverride: TemplateActionConfig =
          actionId === "reject"
            ? {
                id: "reject",
                label: "Reject",
                kind: "decision",
                decision_value: "rejected",
                style: "destructive",
                // requires_feedback intentionally omitted for legacy compat.
              }
            : {
                id: "approve",
                label: "Approve",
                kind: "decision",
                decision_value: "approved",
                style: "primary",
              };

        // Legacy carry-through columns: prompt_edit, action_value, action_label
        // were optional fields on /decide that don't exist on /action. Pass via
        // additionalFields so they land on the same UPDATE without altering the
        // action service's contract.
        const additionalFields: Record<string, unknown> = {};
        if (prompt_edit !== undefined) additionalFields.prompt_edit = prompt_edit;
        if (action_value !== undefined) additionalFields.action_value = action_value;
        if (action_label !== undefined) additionalFields.action_label = action_label;
        // Legacy "edited" decision overrides the canonical decision column —
        // executeReviewAction would write "approved" otherwise (action_id is
        // "approve"). Setting via additionalFields applies after the action
        // service's stateUpdate in the same atomic UPDATE.
        if (decision === "edited") additionalFields.decision = "edited";
        // Legacy escape hatch: api-key auth with body.reviewer set the
        // decided_by column to the supplied reviewer name (NOT the api-key
        // prefix). Audit actor stays "agent:<prefix>" — these have different
        // sources legacy-side. Honor for both auth types when bodyReviewer is
        // present (session path already maps reviewer to actor.id).
        if (actor.kind === "agent" && reviewer) {
          additionalFields.decided_by = reviewer;
        }

        const updated = await executeReviewAction({
          db,
          webhooks: deps.webhooks,
          eventBus: deps.eventBus,
          auditService,
          reviewId,
          projectId,
          actor,
          triggerPath: "manual",
          actionId,
          feedback,
          editedPayload: edited_payload,
          expectedVersion: version,
          requestId: req.requestId,
          additionalFields,
          snapshotPrepend: [legacyOverride],
        });

        // Dual-fire legacy audit event per spec §4.5 + §11.2 (one-minor-version
        // backwards compat). New review.action_taken audit was emitted by
        // executeReviewAction; this adds the legacy review.decided so SDK
        // consumers filtering audit by action='review.decided' continue to see
        // these events.
        if (auditService) {
          auditService
            .log({
              action: "review.decided",
              actor: `${actor.kind}:${actor.id}`,
              resource_type: "review",
              resource_id: updated.id,
              details: {
                decision: updated.decision,
                reviewer: updated.decided_by,
                ...(attestedReviewer ? { attested_reviewer: attestedReviewer } : {}),
              },
              project_id: projectId,
            })
            .catch(() => {});
        }

        setDeprecationHeaders(res, reviewId);
        res.json(envelope("review", { ...reviewPayload(updated), iteration_count: updated.current_version - 1 }));
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/v1/reviews/:id/retry — DEPRECATED alias for POST /action with
  // action_id=request_changes.
  router.post(
    "/:id/retry",
    requireScope("reviews:decide"),
    rateLimitByKey(),
    validate({ body: ReviewRetryBodySchema }),
    async (req, res, next) => {
      try {
        const reviewId = String(req.params.id);
        const projectId = await resolveProjectId(req, db, reviewId);
        if (!projectId) {
          throw new NotFoundError("Review not found", "review_not_found");
        }

        await assertChainStepAllows(db, req, reviewId, projectId, "reviews:decide", auditService);

        const { feedback, prompt_edit } = req.body;
        const actor = buildLegacyActor(req);

        const additionalFields: Record<string, unknown> = {};
        if (prompt_edit !== undefined) additionalFields.prompt_edit = prompt_edit;

        const updated = await executeReviewAction({
          db,
          webhooks: deps.webhooks,
          eventBus: deps.eventBus,
          auditService,
          reviewId,
          projectId,
          actor,
          triggerPath: "manual",
          actionId: "request_changes",
          feedback,
          requestId: req.requestId,
          additionalFields,
        });

        // Dual-fire legacy audit event. Note the legacy event name is
        // "review.changes_requested" (audit) NOT "review.retried" (eventBus +
        // webhook). The action_taken audit was already emitted by
        // executeReviewAction; this adds the legacy audit only.
        if (auditService) {
          auditService
            .log({
              action: "review.changes_requested",
              actor: `${actor.kind}:${actor.id}`,
              resource_type: "review",
              resource_id: updated.id,
              details: { feedback, prompt_edit },
              project_id: projectId,
            })
            .catch(() => {});
        }

        setDeprecationHeaders(res, reviewId);
        res.json(envelope("review", { ...reviewPayload(updated), iteration_count: updated.current_version - 1 }));
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/v1/reviews/:id/cancel-request — DEPRECATED alias for POST /action
  // with action_id=cancel_iteration.
  router.post(
    "/:id/cancel-request",
    requireScope("reviews:decide"),
    rateLimitByKey(),
    async (req, res, next) => {
      try {
        const reviewId = String(req.params.id);
        const projectId = await resolveProjectId(req, db, reviewId);
        if (!projectId) {
          throw new NotFoundError("Review not found", "review_not_found");
        }

        await assertChainStepAllows(db, req, reviewId, projectId, "reviews:decide", auditService);

        const actor = buildLegacyActor(req);

        const updated = await executeReviewAction({
          db,
          webhooks: deps.webhooks,
          eventBus: deps.eventBus,
          auditService,
          reviewId,
          projectId,
          actor,
          triggerPath: "manual",
          actionId: "cancel_iteration",
          requestId: req.requestId,
        });

        // Dual-fire legacy audit event. Legacy /cancel-request never fired an
        // outbound HTTP webhook (verified Phase 3 commit 1 probe), so the
        // dispatcher's sendActionTaken-only behavior for kind=side_effect is
        // correct — no legacy outbound to dual-fire.
        if (auditService) {
          auditService
            .log({
              action: "review.request_cancelled",
              actor: `${actor.kind}:${actor.id}`,
              resource_type: "review",
              resource_id: updated.id,
              details: {},
              project_id: projectId,
            })
            .catch(() => {});
        }

        setDeprecationHeaders(res, reviewId);
        res.json(envelope("review", { ...reviewPayload(updated), iteration_count: updated.current_version - 1 }));
      } catch (err) {
        next(err);
      }
    },
  );

  // PUT /api/v1/reviews/:id/draft — auto-save draft edits.
  // Cohabits with decide because it represents WIP state of the decide action.
  router.put(
    "/:id/draft",
    rateLimitByKey(),
    validate({ body: ReviewDraftBodySchema }),
    async (req, res, next) => {
      try {
        const reviewer = (req as { reviewer?: { email?: string; name?: string } }).reviewer;
        if (!reviewer) throw new AuthenticationError("Session required for draft save.");

        const id = String(req.params.id);
        const { draft_payload } = req.body;
        const projectId = await resolveProjectId(req, db, id);
        if (!projectId) throw new NotFoundError("Review not found", "review_not_found");

        await assertChainStepAllows(db, req, id, projectId, "reviews:decide", auditService);

        const result = await db
          .update(reviewsTable)
          .set({
            draft_payload,
            draft_by: reviewer.name || reviewer.email,
            draft_at: new Date(),
          })
          .where(
            and(
              eq(reviewsTable.id, id),
              eq(reviewsTable.project_id, projectId),
              sql`${reviewsTable.status} IN ('pending', 'awaiting_iteration')`,
            ),
          )
          .returning({ id: reviewsTable.id });

        if (result.length === 0) {
          throw new ConflictError("Can only save drafts for pending reviews.", "not_pending");
        }

        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /api/v1/reviews/:id/draft — discard draft.
  router.delete("/:id/draft", rateLimitByKey(), async (req, res, next) => {
    try {
      const reviewer = (req as { reviewer?: { email?: string; name?: string } }).reviewer;
      if (!reviewer) throw new AuthenticationError("Session required.");

      const id = String(req.params.id);
      const projectId = await resolveProjectId(req, db, id);
      if (!projectId) throw new NotFoundError("Review not found", "review_not_found");

      await assertChainStepAllows(db, req, id, projectId, "reviews:decide", auditService);

      await db
        .update(reviewsTable)
        .set({ draft_payload: null, draft_by: null, draft_at: null })
        .where(and(eq(reviewsTable.id, id), eq(reviewsTable.project_id, projectId)));

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

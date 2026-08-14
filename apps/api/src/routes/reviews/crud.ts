import { Router, type Response } from "express";
import { eq, and, isNotNull, inArray } from "drizzle-orm";
import { projects, templates as templatesTable, reviews as reviewsTable, notifications, emailSends } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import { validateWebhookUrlWithDns } from "../../lib/ssrf";
import {
  envelope,
  listEnvelope,
  InvalidRequestError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ConflictError,
  type Priority,
  type ChainDefinition,
  ReviewCreateBodySchema,
  ReviewUpdateVersionBodySchema,
  ReviewListQuerySchema,
} from "@gatewerk/shared";
import { validate } from "../../middleware/validate";
import { requireScope } from "../../middleware/require-scope";
import { rateLimitByKey } from "../../middleware/rate-limit-key";
import { resolveProjectId } from "../../lib/resolve-project-id";
import { isUniqueViolation } from "../../lib/pg-error";
import { resolveChainEventFields } from "../../lib/chain-event-context";
import { subjectFromRequest } from "../../policy/subjects";
import { reviewPayload } from "./_helpers";
import type { ReviewRouteDeps } from "./_deps";
import { assertMonitoringEligibility } from "../../services/reviews/monitoring-gate";

// Inline terminal-status set (spec §): a review in one of these states is a
// completed idempotency record — re-creating against it is a hard conflict.
const IDEMPOTENCY_TERMINAL_STATUSES = ["decided", "expired", "archived"];

// Shared idempotency resolution. Looks up an existing review by
// (project_id, idempotency_key) and, when one exists, either throws a 409
// (terminal existing) or writes a 200 with the existing row (non-terminal).
// Runs in TWO places: the pre-insert fast path AND the 23505 catch path after
// a concurrent INSERT loses the race on the partial unique index. Returns true
// when it has written a response (caller must stop); false when no row exists
// (caller continues / re-throws).
async function resolveExistingIdempotent(
  db: AppDb,
  projectId: string,
  idempotencyKey: string,
  res: Response,
): Promise<boolean> {
  const [existing] = await db
    .select()
    .from(reviewsTable)
    .where(
      and(
        eq(reviewsTable.project_id, projectId),
        eq(reviewsTable.idempotency_key, idempotencyKey),
        isNotNull(reviewsTable.idempotency_key),
      ),
    )
    .limit(1);

  if (!existing) return false;

  if (IDEMPOTENCY_TERMINAL_STATUSES.includes(existing.status)) {
    throw new ConflictError(
      "A review with this idempotency_key already exists in a terminal state.",
      "idempotency_key_terminal_conflict",
    );
  }
  // Non-terminal: return the existing review as-is (idempotent success).
  res.status(200).json(envelope("review", { ...reviewPayload(existing), iteration_count: existing.current_version - 1 }));
  return true;
}

export function createReviewCrudRoutes(deps: ReviewRouteDeps): Router {
  const router = Router();
  const { db, service, webhooks: wh, eventBus, auditService, chainEngine } = deps;

  // POST /api/v1/reviews — create review
  router.post(
    "/",
    requireScope("reviews:create"),
    rateLimitByKey(),
    validate({ body: ReviewCreateBodySchema }),
    async (req, res, next) => {
    try {
      const projectId = (req as any).projectId;

      if (!projectId) {
        throw new ForbiddenError("Review creation requires an API key");
      }

      const { template, payload, callback_url, priority, actions, confidence, irreversibility, oversight, metadata, timeout, assignment_ladder, idempotency_key, trace_url, max_iterations } = req.body;

      // Route-layer https-only guard on trace_url — defense-in-depth on top of
      // the Zod refine in ReviewCreateBodySchema and the DB CHECK constraint.
      if (trace_url !== undefined && trace_url !== null) {
        try {
          if (new URL(trace_url).protocol !== "https:") {
            throw new InvalidRequestError("trace_url must use the https scheme.", "trace_url", "invalid_trace_url");
          }
        } catch (err: any) {
          if (err?.code === "invalid_trace_url") throw err;
          throw new InvalidRequestError("trace_url must be a valid https URL.", "trace_url", "invalid_trace_url");
        }
      }

      // Idempotency fast path: runs BEFORE SSRF/callback_url and payload size
      // checks so a retry of a previously-created review short-circuits early.
      // Terminal statuses (decided/expired/archived) → 409; non-terminal → 200
      // with the existing row. Only fires when a key is present. This is a
      // check-then-act SELECT; the authoritative guard against a concurrent
      // racer is the 23505 catch around service.create below.
      if (idempotency_key) {
        if (await resolveExistingIdempotent(db, projectId, idempotency_key, res)) return;
      }

      if (callback_url) {
        try {
          await validateWebhookUrlWithDns(callback_url);
        } catch (err: any) {
          throw new InvalidRequestError(`Invalid callback URL: ${err.message}`, "callback_url", "invalid_callback_url");
        }
      }

      // Payload size validation: total payload > 5MB → 413
      const payloadStr = JSON.stringify(payload);
      if (payloadStr.length > 5 * 1024 * 1024) {
        throw new PayloadTooLargeError("Total payload exceeds 5MB limit.", "payload_too_large");
      }

      // Per-field size check: any string field > 1MB → 413
      for (const [key, value] of Object.entries(payload)) {
        if (typeof value === "string" && value.length > 1024 * 1024) {
          throw new PayloadTooLargeError(`Field '${key}' exceeds 1MB limit.`, "field_too_large");
        }
      }

      // Timeout validation: agent override must be at least 60 seconds
      if (timeout?.seconds !== undefined && timeout.seconds !== null) {
        if (typeof timeout.seconds !== "number" || timeout.seconds < 60) {
          throw new InvalidRequestError("Timeout must be at least 60 seconds.", "timeout", "invalid_timeout");
        }
      }

      // Template scoping: if the API key is restricted to specific templates, enforce it
      const templateIds: string[] | null = (req as any).templateIds;
      if (templateIds !== null && templateIds !== undefined) {
        const [tpl] = await db
          .select({ id: templatesTable.id })
          .from(templatesTable)
          .where(and(eq(templatesTable.slug, template), eq(templatesTable.project_id, projectId)))
          .limit(1);

        if (!tpl || !templateIds.includes(tpl.id)) {
          throw new ForbiddenError(
            `API key does not have access to template '${template}'`,
            "template_not_allowed"
          );
        }
      }

      // M12: chain spawning. Look up the target template's chain_config; if
      // present, route through ChainEngine.createRun instead of the standalone
      // review create path. The new review becomes step 1 of the chain.
      //
      // chain_config + assignment_ladder is rejected — both mechanisms claim
      // ownership of the review's assignee progression and combining them
      // would produce non-deterministic step ownership. Per-step assignees on
      // the chain definition cover the multi-assignee use case already.
      const [targetTemplate] = await db
        .select({
          chain_config: templatesTable.chain_config,
          allow_monitoring: templatesTable.allow_monitoring,
          auto_approve: templatesTable.auto_approve,
          timeout_seconds: templatesTable.timeout_seconds,
        })
        .from(templatesTable)
        .where(and(eq(templatesTable.slug, template), eq(templatesTable.project_id, projectId)))
        .limit(1);

      // HOTL monitoring gate: eligibility is decided exactly once, here.
      // Runs before the chain branch so a monitoring request against a chain
      // template is refused (spec §4.1) instead of spawning a run. A missing
      // template falls through to service.create's template_not_found.
      if (oversight === "monitoring" && targetTemplate) {
        assertMonitoringEligibility(
          { irreversibility, callback_url, timeout, assignment_ladder },
          targetTemplate,
        );
      }

      const chainConfig = targetTemplate?.chain_config as ChainDefinition | null | undefined;
      if (chainConfig) {
        if (assignment_ladder && assignment_ladder.length > 0) {
          throw new InvalidRequestError(
            "Template defines a chain; assignment_ladder cannot be combined with chain_config.",
            "assignment_ladder",
            "chain_and_ladder_exclusive",
          );
        }
        if (!chainEngine) {
          throw new Error("ChainEngine is required to spawn a chain but was not injected");
        }
        const actor = (req as any).authType === "session"
          ? `reviewer:${(req as any).reviewer?.email || "unknown"}`
          : `agent:${(req as any).apiKeyPrefix || "unknown"}`;
        const spawn = await chainEngine.createRun({
          definition: chainConfig,
          // C1: the template this review was POSTed against IS the route's
          // entry template. The chain_config hangs off it, so the definition
          // does not repeat it and the engine is told directly.
          entry_template_slug: template,
          initial_payload: payload as Record<string, unknown>,
          callback_url: callback_url || (req as any).defaultCallbackUrl || undefined,
          metadata: metadata as Record<string, unknown> | undefined,
          project_id: projectId,
          created_by: actor,
        });
        // Fetch the materialized step-1 review so the response shape matches
        // the standalone create path (envelope("review", ...)). The chain
        // engine inserted it, but didn't return the row — read it back.
        const [stepOneReview] = await db
          .select()
          .from(reviewsTable)
          .where(eq(reviewsTable.id, spawn.step_1_review_id))
          .limit(1);
        if (!stepOneReview) {
          throw new Error("step 1 review missing after chain spawn");
        }
        // Live-feed parity: standalone POST /reviews emits review.created so
        // the SSE feed updates the inbox in real time. Chain-spawned reviews
        // need the same emit so the inbox updates when an agent creates a
        // chain via this path. Chain context is threaded so dashboard SSE
        // consumers can invalidate the chain queryKey on receive — step 1
        // of every chain spawn carries chain_run_id + chain_step_id by
        // construction.
        if (eventBus) {
          const chainCtx = await resolveChainEventFields(
            db,
            stepOneReview.chain_run_id,
            stepOneReview.chain_step_id,
          );
          const eventData = {
            review_id: stepOneReview.id,
            template: stepOneReview.template_slug,
            project_id: stepOneReview.project_id,
            priority: stepOneReview.priority as Priority,
            created_at: stepOneReview.created_at.toISOString(),
            ...(chainCtx ?? {}),
          };
          eventBus.emit("review.created", eventData);
          if (stepOneReview.priority === "high" || stepOneReview.priority === "critical") {
            eventBus.emit("review.urgent", eventData);
          }
        }
        return res.status(201).json(envelope("review", { ...reviewPayload(stepOneReview), iteration_count: stepOneReview.current_version - 1 }));
      }

      const assignee = req.body.assignee || (req as any).defaultReviewer || undefined;

      let review;
      try {
        review = await service.create(projectId, {
          template, payload, callback_url, priority, actions, confidence, irreversibility, oversight, assignee, metadata, timeout,
          assignment_ladder, idempotency_key, trace_url, max_iterations,
        });
      } catch (err) {
        // Concurrent-retry race: two POSTs with the same new idempotency_key
        // both passed the fast-path SELECT (it was empty for both), both
        // INSERTed, and the partial unique index rejected the loser with
        // Postgres 23505. Re-run the idempotency resolution: the winner row
        // now exists, so return it (200) or 409 if it is already terminal —
        // never a 500. Matches the pattern in routes/templates.ts.
        // Read through drizzle's DrizzleQueryError wrapper (lib/pg-error.ts).
        // The direct `err.code` read this used to do was always undefined, so
        // this branch never ran and the loser of the race got the 500 the
        // comment above promises it never gets.
        if (
          idempotency_key &&
          isUniqueViolation(err, "reviews_project_id_idempotency_key_idx")
        ) {
          if (await resolveExistingIdempotent(db, projectId, idempotency_key, res)) return;
        }
        throw err;
      }

      // If auto-approved, fire webhook immediately and skip notification events
      if ((review as any).auto_approved) {
        if (review.callback_url) {
          const [proj] = await db
            .select({ hmac_secret: projects.hmac_secret })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1);
          if (proj) {
            wh.sendDecision({
              callback_url: review.callback_url,
              hmac_secret: proj.hmac_secret,
              review_id: review.id,
              // Standalone create path only: a chain-spawned review returns from
              // the chain branch above and never reaches here, and the engine
              // pins chain steps to oversight:'blocking' anyway. Read off the
              // row rather than hardcoding null so the guard stays true if that
              // ever changes (C1 charter §5.1).
              chain_run_id: review.chain_run_id ?? null,
              decision: "approved",
              decided_at: review.decided_at?.toISOString() || new Date().toISOString(),
              approved_value: review.payload as Record<string, unknown>,
              was_edited: false,
              auto_approved: true,
              action_value: "auto_approve",
              action_label: "Auto-approved",
              // Derived: ALWAYS current_version - 1 (0 for a v1 auto-approve).
              // The frozen decision callback contract requires iteration_count
              // present on every decision webhook; consistent with the dispatch
              // and timeout-worker callers and the HTTP serialization layer.
              iteration_count: review.current_version - 1,
              request_id: req.requestId,
            }).catch(console.error);
          } else {
            // Race: project deleted between review create and this lookup.
            // Do not fall back to env-level secret — removed deliberately;
            // a shared fallback secret defeats per-project HMAC isolation.
            console.error("Webhook skipped: project not found during HMAC lookup", {
              projectId,
              review_id: review.id,
              request_id: req.requestId,
            });
          }
        }
        if (auditService) {
          const apiKeyPrefix = (req as any).apiKeyPrefix || "unknown";
          auditService.log({
            action: "review.auto_approved",
            actor: `agent:${apiKeyPrefix}`,
            resource_type: "review",
            resource_id: review.id,
            details: { template: review.template_slug },
            project_id: projectId,
          }).catch(() => {});
        }
        return res.status(201).json(envelope("review", { ...reviewPayload(review), iteration_count: review.current_version - 1 }));
      }

      // Audit log
      if (auditService) {
        const apiKeyPrefix = (req as any).apiKeyPrefix || "unknown";
        auditService.log({
          action: "review.created",
          actor: `agent:${apiKeyPrefix}`,
          resource_type: "review",
          resource_id: review.id,
          details: { template: review.template_slug, priority: review.priority, oversight: review.oversight },
          project_id: projectId,
        }).catch(() => {});
      }

      // Emit events
      if (eventBus) {
        const eventData = {
          review_id: review.id,
          template: review.template_slug,
          project_id: review.project_id,
          priority: review.priority as Priority,
          created_at: review.created_at.toISOString(),
        };
        if (review.oversight === "monitoring") {
          // Distinct event (spec §4.9): separately mutable in channel config
          // without muting blocking reviews. No review.urgent — urgency for a
          // monitoring item is the countdown, not a pre-decision ping.
          // expires_at rides along so consumers can render the countdown
          // without a refetch.
          eventBus.emit("review.monitoring_created", {
            ...eventData,
            expires_at: review.expires_at?.toISOString(),
          });
        } else {
          eventBus.emit("review.created", eventData);
          if (review.priority === "high" || review.priority === "critical") {
            eventBus.emit("review.urgent", eventData);
          }
        }
      }

      res.status(201).json(envelope("review", { ...reviewPayload(review), iteration_count: review.current_version - 1 }));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/reviews — list reviews
  router.get(
    "/",
    requireScope("reviews:read"),
    validate({ query: ReviewListQuerySchema }),
    async (req, res, next) => {
    try {
      const projectId = (req as any).projectId;

      const { status, priority, template, assignee, limit, offset } = req.query as unknown as {
        status?: string; priority?: string; template?: string; assignee?: string;
        limit?: number; offset?: number;
      };
      const result = await service.list(projectId || null, {
        status, priority, template, assignee, limit, offset,
      });

      // Task 7 (C-1 fix): the bounced-notification flag must be injected here
      // too, not only on the detail route — ReviewRow (the inbox chip) is fed
      // exclusively by this list endpoint, so a detail-only flag can never
      // render. One aggregate query over the whole page's review ids rather
      // than N+1 per row, mirroring how iteration_count is already batched
      // above: gather ids, join notifications to email_sends for any
      // non-null bounced_at, build a Set, map.
      const reviewIds = result.items.map((r: any) => r.id);
      const bouncedRows = reviewIds.length > 0
        ? await db
            .select({ review_id: notifications.review_id })
            .from(notifications)
            .innerJoin(emailSends, eq(emailSends.notification_id, notifications.id))
            .where(and(inArray(notifications.review_id, reviewIds), isNotNull(emailSends.bounced_at)))
        : [];
      const bouncedReviewIds = new Set(bouncedRows.map((b) => b.review_id));

      const itemsWithCount = result.items.map((r: any) => ({
        ...r,
        iteration_count: r.current_version - 1,
        notification_delivery_failed: bouncedReviewIds.has(r.id),
      }));
      res.json(listEnvelope("review", itemsWithCount, { has_more: result.has_more, total: result.total }));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/reviews/:id — get review
  router.get("/:id", requireScope("reviews:read"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db, String(req.params.id));
      if (!projectId) {
        throw new NotFoundError("Review not found", "review_not_found");
      }
      // Inline notes (AC #10): pass the requester's user id so the jsonb_agg
      // subquery in getByIdWithTemplate can filter private notes that don't
      // belong to them. api_key callers map to null → shared-only.
      const subject = subjectFromRequest(req);
      const subjectUser = subject?.kind === "session" ? subject.userId : null;
      const review = await service.getByIdWithTemplate(
        projectId,
        String(req.params.id),
        subjectUser,
      );
      if (!review) {
        throw new NotFoundError("Review not found", "review_not_found");
      }

      // Task 7: surface a hard-bounced "your turn" notification. Single
      // boolean — the UI needs "was this person reachable", not a delivery
      // log. A review with no notification (or no bounced send) yields
      // false rather than erroring.
      const [bouncedNotification] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .innerJoin(emailSends, eq(emailSends.notification_id, notifications.id))
        .where(and(eq(notifications.review_id, review.id), isNotNull(emailSends.bounced_at)))
        .limit(1);

      res.json(envelope("review", {
        ...reviewPayload(review),
        iteration_count: (review as any).current_version - 1,
        notification_delivery_failed: Boolean(bouncedNotification),
      }));
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/v1/reviews/:id — update review (agent submits new version)
  router.put("/:id", requireScope("reviews:create"), validate({ body: ReviewUpdateVersionBodySchema }), async (req, res, next) => {
    try {
      const projectId = (req as any).projectId;

      if (!projectId) {
        throw new ForbiddenError("Review updates require an API key");
      }

      const { payload, version } = req.body;
      const updated = await service.updateVersion(projectId, String(req.params.id), { payload, version });
      res.json(envelope("review", { ...reviewPayload(updated), iteration_count: updated.current_version - 1 }));
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/v1/reviews/:id — hard delete (cascades to versions, notes, tokens)
  router.delete("/:id", requireScope("reviews:decide"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db, String(req.params.id));
      if (!projectId) throw new NotFoundError("Review not found", "review_not_found");
      const deleted = await service.deleteReview(projectId, String(req.params.id));
      if (auditService) {
        const actor = (req as any).authType === "session"
          ? `reviewer:${(req as any).reviewer?.email}`
          : `agent:${(req as any).apiKeyPrefix || "unknown"}`;
        auditService.log({ action: "review.deleted", actor, resource_type: "review", resource_id: deleted.id, details: {}, project_id: projectId }).catch(() => {});
      }
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  return router;
}

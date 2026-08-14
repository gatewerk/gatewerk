import { Router } from "express";
import { eq, and, inArray, desc } from "drizzle-orm";
import { chainRuns } from "@gatewerk/db/src/schema/index";
import {
  envelope,
  listEnvelope,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  ChainRunCreateBodySchema,
  type Priority,
} from "@gatewerk/shared";
import { reviews, reviewTokens } from "@gatewerk/db/src/schema/index";
import { ConflictError } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import type { ChainEngine } from "../services/chain-engine";
import type { EventBus } from "../services/events";
import { validate } from "../middleware/validate";
import { requireScope } from "../middleware/require-scope";
import { rateLimitByKey } from "../middleware/rate-limit-key";
import { resolveProjectId } from "../lib/resolve-project-id";
import { isPrivilegedChainViewer } from "../policy";
import { resolveChainEventFields } from "../lib/chain-event-context";
import { validateWebhookUrlWithDns } from "../lib/ssrf";
import { deriveTokenStatus } from "../services/review-tokens";
import {
  scrubAssigneeSpecPii,
  scrubFutureStepAssigneeSpec,
} from "../services/chain-engine-token-resolution";

// Chain envelope token_status projection (§13).
//
// For external_token steps, the chain timeline UI surfaces a small badge
// showing the token lifecycle state (active / approved / declined /
// expired / revoked). The underlying logic is `deriveTokenStatus` from
// services/review-tokens.ts (single source of truth — used here AND by
// the token history list endpoint, so the precedence rules stay aligned).
//
// PII-as-type-absence: this projection MUST NOT surface auth_email or
// auth_user_id. We project ONLY the lifecycle status string and a
// scrubbed assignee_spec via the shared scrubAssigneeSpecPii helper.
// auth_level is operator-set and surfaced via assignee_spec; auth_email
// and auth_user_id are stripped at projection time.
async function buildTokenStatusByReviewId(
  db: AppDb,
  reviewIds: string[],
): Promise<Map<string, ReturnType<typeof deriveTokenStatus>>> {
  const out = new Map<string, ReturnType<typeof deriveTokenStatus>>();
  if (reviewIds.length === 0) return out;

  // Fetch the latest token row per review_id. The composite index
  // review_tokens_review_id_created_at_idx (DESC) makes this cheap; we
  // sort + de-dup in JS rather than emit a window function so this stays
  // portable to OSS Postgres without `DISTINCT ON` quirks.
  const rows = await db
    .select()
    .from(reviewTokens)
    .where(inArray(reviewTokens.review_id, reviewIds))
    .orderBy(desc(reviewTokens.created_at));

  for (const row of rows) {
    if (out.has(row.review_id)) continue; // first wins → latest token
    out.set(row.review_id, deriveTokenStatus(row));
  }
  return out;
}

/**
 * The relay (C1, charter §3): what each step's reviewer decided, so the next
 * one can see the judgments that came before theirs without leaving their own
 * review. The junior's hour is what makes the senior's minute possible, and
 * until now the API carried no trace of it — a step's decision lived only on
 * its own review row, which a later reviewer has no reason to go looking for.
 *
 * One query for the whole run, keyed by review id. Only TERMINAL reviews
 * contribute: an in-flight draft or a half-finished iteration is not a
 * judgment, and surfacing one as though it were would be worse than silence.
 */
async function buildDecisionByReviewId(
  db: AppDb,
  reviewIds: string[],
): Promise<Map<string, { decision: string | null; decided_by: string | null; decided_at: string | null; feedback: string | null }>> {
  const out = new Map<string, { decision: string | null; decided_by: string | null; decided_at: string | null; feedback: string | null }>();
  if (reviewIds.length === 0) return out;

  const rows = await db
    .select({
      id: reviews.id,
      status: reviews.status,
      decision: reviews.decision,
      decided_by: reviews.decided_by,
      decided_at: reviews.decided_at,
      feedback: reviews.feedback,
    })
    .from(reviews)
    .where(inArray(reviews.id, reviewIds));

  for (const row of rows) {
    if (row.status !== "decided" && row.status !== "expired") continue;
    out.set(row.id, {
      decision: row.decision,
      decided_by: row.decided_by,
      decided_at: row.decided_at ? row.decided_at.toISOString() : null,
      feedback: row.feedback,
    });
  }
  return out;
}

// Chain-run REST surface (M10 Phase 1). Three endpoints mounted under the
// dualRouter in app.ts:
//   POST /api/v1/chain-runs          — create + start a chain run
//   GET  /api/v1/chain-runs/:id      — full chain run state (run + steps)
//   GET  /api/v1/reviews/:id/chain   — chain context for a review
//
// Scope gating: POST and abort require `chains:create` (Task 3 BREAKING
// CHANGE — was `templates:write`). GETs require `reviews:read` since
// chain state is effectively reviews-adjacent data.
// Admin sessions receive chains:create via ADMIN_SCOPES = SCOPES.
// Non-admin API keys carrying only templates:write must be re-issued.

export function createChainRoutes(db: AppDb, engine: ChainEngine, eventBus?: EventBus): Router {
  const router = Router();

  // POST /api/v1/chain-runs — create + start a sequential chain
  router.post(
    "/chain-runs",
    requireScope("chains:create"),
    rateLimitByKey(),
    validate({ body: ChainRunCreateBodySchema }),
    async (req, res, next) => {
      try {
        // API keys always have req.projectId set by the auth middleware.
        // Session auth (admins) does not — use the oldest-project fallback
        // (resolveProjectId, same pattern as GET /chain-runs/:id and the
        // stats routes). This lets session admins create chain runs without
        // needing to supply a project-scoped API key.
        const projectId = (req as any).projectId ?? (await resolveProjectId(req, db));
        if (!projectId) {
          throw new ForbiddenError("Chain creation requires a project-scoped context");
        }

        const { definition, initial_payload, callback_url, metadata } = req.body;

        // C1: a direct chain run must name its entry template. Unlike a
        // template's own chain_config, which hangs off the template it belongs
        // to, nothing here implies one. Checked at the route rather than in the
        // zod schema because the schema is shared with chain_config, where the
        // field is correctly absent. steps[0].template is accepted as the
        // legacy shape so an existing integration keeps working.
        if (!definition.template && !definition.steps?.[0]?.template) {
          throw new InvalidRequestError(
            "Chain definition must name a template. Set `definition.template` to the template every step reviews against.",
            "definition.template",
            "entry_template_required",
          );
        }

        // SSRF guard — mirrors POST /api/v1/reviews (routes/reviews/crud.ts):
        // same helper, same error wrapping, run before any work is done so a
        // chain run can't be pointed at a private/metadata address via its
        // own callback_url.
        if (callback_url) {
          try {
            await validateWebhookUrlWithDns(callback_url);
          } catch (err: any) {
            throw new InvalidRequestError(`Invalid callback URL: ${err.message}`, "callback_url", "invalid_callback_url");
          }
        }

        const actor = (req as any).authType === "session"
          ? `reviewer:${(req as any).reviewer?.email || "unknown"}`
          : `agent:${(req as any).apiKeyPrefix || "unknown"}`;

        const result = await engine.createRun({
          definition,
          initial_payload,
          callback_url,
          metadata,
          project_id: projectId,
          created_by: actor,
        });

        // Fetch the full chain run + steps for the response so the caller
        // gets the complete state in a single round-trip (mirrors how
        // POST /reviews returns the review itself, not just an id).
        const full = await engine.getRun(result.chain_run_id, projectId);
        if (!full) {
          throw new Error("chain_run missing after createRun");
        }

        // Live-feed parity with POST /reviews chain-spawn branch (M12, see
        // routes/reviews/crud.ts:142-154). Direct chain creation must emit
        // review.created so the SSE feed updates the inbox in real time;
        // without this the inbox is silent until the next poll/refresh.
        if (eventBus) {
          const [stepOneReview] = await db
            .select()
            .from(reviews)
            .where(eq(reviews.id, result.step_1_review_id))
            .limit(1);
          if (stepOneReview) {
            // Step 1 is always chain-attached on this path (POST /chain-runs
            // creates the chain by definition). Resolve the four chain
            // context fields so dashboard SSE consumers can invalidate the
            // chain queryKey on receive — observability audit P1.
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
        }

        const tokenStatusByReview = await buildTokenStatusByReviewId(
          db,
          full.steps.map((s) => s.review_id).filter((x): x is string => x !== null),
        );
        // POST caller is always the chain creator — privileged for future-step
        // identity (they authored the definition; they already know who's next).
        res.status(201).json(envelope("chain_run", {
          ...full.run,
          created_at: full.run.created_at.toISOString(),
          completed_at: full.run.completed_at ? full.run.completed_at.toISOString() : null,
          steps: full.steps.map((s) => {
            const piiScrubbed = { ...s, assignee_spec: scrubAssigneeSpecPii(s.assignee_spec) ?? s.assignee_spec };
            return scrubFutureStepAssigneeSpec({
              ...piiScrubbed,
              materialized_at: s.materialized_at ? s.materialized_at.toISOString() : null,
              token_status: s.review_id ? (tokenStatusByReview.get(s.review_id) ?? null) : null,
            }, { isPrivileged: true });
          }),
          step_1_review_id: result.step_1_review_id,
        }));
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/v1/chain-runs/:id — fetch chain run + steps.
  //
  // Previously passed `projectId || undefined` to engine.getRun and the
  // engine conditionally skipped the project filter when falsy. Session-auth
  // middleware doesn't set req.projectId for these paths, so session callers
  // would have read across tenants on cloud (multi-project). OSS
  // single-project deployment was benign.
  //
  // Mirrors the resolveProjectId pattern from routes/stats.ts.
  // resolveProjectId returns req.projectId for API keys and the
  // session caller's active project (single-project fallback on OSS) for
  // session callers. We do NOT pass the chain-run id as a hint — that would
  // resolve to the resource's own project_id and defeat tenant isolation
  // (the whole point of the fix). engine.getRun then enforces the
  // chain_run.project_id == resolvedProjectId AND filter, so a session in
  // project A asking for a chain in project B yields null → 404.
  router.get("/chain-runs/:id", requireScope("reviews:read"), async (req, res, next) => {
    try {
      const runId = String(req.params.id);
      const projectId = (req as any).projectId ?? (await resolveProjectId(req, db));
      if (!projectId) {
        throw new NotFoundError("Chain run not found", "chain_run_not_found");
      }
      const full = await engine.getRun(runId, projectId);
      if (!full) {
        throw new NotFoundError("Chain run not found", "chain_run_not_found");
      }
      const tokenStatusByReview = await buildTokenStatusByReviewId(
        db,
        full.steps.map((s) => s.review_id).filter((x): x is string => x !== null),
      );
      // Privileged = admin session OR chain owner (session). API-key callers
      // are not owners and get kind-only on pending steps.
      const isGetRunPrivileged = isPrivilegedChainViewer(req, full.run.created_by);
      res.json(envelope("chain_run", {
        ...full.run,
        created_at: full.run.created_at.toISOString(),
        completed_at: full.run.completed_at ? full.run.completed_at.toISOString() : null,
        steps: full.steps.map((s) => {
          const piiScrubbed = { ...s, assignee_spec: scrubAssigneeSpecPii(s.assignee_spec) ?? s.assignee_spec };
          return scrubFutureStepAssigneeSpec({
            ...piiScrubbed,
            materialized_at: s.materialized_at ? s.materialized_at.toISOString() : null,
            token_status: s.review_id ? (tokenStatusByReview.get(s.review_id) ?? null) : null,
          }, { isPrivileged: isGetRunPrivileged });
        }),
      }));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/reviews/:id/chain — chain context for a review. Returns the
  // same shape as GET /chain-runs/:id, with the addition of a
  // `current_step_number` pointer so the frontend can highlight the
  // caller's step position without a second join.
  //
  // Same tightening as GET /chain-runs/:id. We deliberately do NOT pass the
  // review id as a hint to resolveProjectId — passing the id resolves to
  // the review's own project, defeating tenant isolation. engine.getChain-
  // ContextForReview enforces the project filter, so a session in project A
  // asking for a review in project B yields null → 404.
  router.get("/reviews/:id/chain", requireScope("reviews:read"), async (req, res, next) => {
    try {
      const reviewId = String(req.params.id);
      const projectId = (req as any).projectId ?? (await resolveProjectId(req, db));
      if (!projectId) {
        throw new NotFoundError("Review is not part of a chain", "review_not_in_chain");
      }
      const full = await engine.getChainContextForReview(reviewId, projectId);
      if (!full) {
        throw new NotFoundError("Review is not part of a chain", "review_not_in_chain");
      }
      const [review] = await db
        .select({ chain_step_id: reviews.chain_step_id })
        .from(reviews)
        .where(eq(reviews.id, reviewId))
        .limit(1);
      const currentStep = review?.chain_step_id
        ? full.steps.find((s) => s.id === review.chain_step_id)
        : undefined;
      const materializedReviewIds = full.steps
        .map((s) => s.review_id)
        .filter((x): x is string => x !== null);
      const tokenStatusByReview = await buildTokenStatusByReviewId(db, materializedReviewIds);
      const decisionByReview = await buildDecisionByReviewId(db, materializedReviewIds);
      // Same ownership check as GET /chain-runs/:id.
      const isGetChainPrivileged = isPrivilegedChainViewer(req, full.run.created_by);
      res.json(envelope("chain_run", {
        ...full.run,
        created_at: full.run.created_at.toISOString(),
        completed_at: full.run.completed_at ? full.run.completed_at.toISOString() : null,
        steps: full.steps.map((s) => {
          const piiScrubbed = { ...s, assignee_spec: scrubAssigneeSpecPii(s.assignee_spec) ?? s.assignee_spec };
          return scrubFutureStepAssigneeSpec({
            ...piiScrubbed,
            // `name` is stored inside assignee_spec (the full step definition
            // is persisted there by the engine). Project it explicitly so the
            // ChainStepper frontend field is populated — the spread of the DB
            // row above does not carry it because chain_steps has no name column.
            name: (s.assignee_spec as { name?: string | null } | null)?.name ?? null,
            // C1: the step's guidance — one line telling that step's reviewer
            // what to weigh. Stored inside the step definition like `name`,
            // and projected explicitly for the same reason: chain_steps has no
            // column for it, so the row spread above does not carry it.
            guidance: (s.assignee_spec as { description?: string | null } | null)?.description ?? null,
            materialized_at: s.materialized_at ? s.materialized_at.toISOString() : null,
            token_status: s.review_id ? (tokenStatusByReview.get(s.review_id) ?? null) : null,
            // The relay. Null on every step that has not reached a decision.
            ...(s.review_id && decisionByReview.has(s.review_id)
              ? decisionByReview.get(s.review_id)!
              : { decision: null, decided_by: null, decided_at: null, feedback: null }),
          }, { isPrivileged: isGetChainPrivileged });
        }),
        current_step_number: currentStep?.step_number ?? null,
      }));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/chain-runs/:id/abort — operator force-stop.
  //
  // Atomically transitions an active run to 'aborted' and all pending/active
  // steps to 'skipped'. Requires `chains:create` (Task 3 BREAKING — was
  // `templates:write`; admin sessions auto-receive it via ADMIN_SCOPES=SCOPES).
  //
  // Returns: 200 { status:"aborted", skipped:<n> }
  //          409 { error.code:"chain_run_not_active" } — run exists but not active
  //          404 — run not found in this project
  router.post(
    "/chain-runs/:id/abort",
    requireScope("chains:create"),
    async (req, res, next) => {
      try {
        const runId = String(req.params.id);
        const projectId = (req as any).projectId ?? (await resolveProjectId(req, db));
        if (!projectId) {
          throw new NotFoundError("Chain run not found", "chain_run_not_found");
        }

        const actor =
          (req as any).authType === "session"
            ? `reviewer:${(req as any).reviewer?.email || "unknown"}`
            : `agent:${(req as any).apiKeyPrefix || "unknown"}`;

        const result = await engine.abortRun(runId, projectId, actor);
        if (!result) {
          // null means the atomic WHERE id=? AND project_id=? AND status='active'
          // RETURNING returned 0 rows. Could be not-found OR already terminal —
          // distinguish via a follow-up read. CRITICAL: this read MUST be
          // project-scoped too; filtering by id alone would 409 on a run owned
          // by another project, leaking that the id exists. With the project
          // filter, a cross-project id resolves to 404 (same as not-found).
          const [existing] = await db
            .select({ id: chainRuns.id })
            .from(chainRuns)
            .where(and(eq(chainRuns.id, runId), eq(chainRuns.project_id, projectId)))
            .limit(1);
          if (existing) {
            throw new ConflictError(
              "Chain run is not in an active state",
              "chain_run_not_active",
            );
          }
          throw new NotFoundError("Chain run not found", "chain_run_not_found");
        }

        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // Unused listEnvelope import guard — keep the listEnvelope API available
  // for future `GET /chain-runs` list endpoint (M11+).
  void listEnvelope;

  return router;
}

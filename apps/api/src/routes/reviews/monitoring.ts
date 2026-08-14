import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { reviews as reviewsTable, projects } from "@gatewerk/db/src/schema/index";
import {
  envelope,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ReviewVetoBodySchema,
  type Priority,
} from "@gatewerk/shared";
import { requireScope } from "../../middleware/require-scope";
import { validate } from "../../middleware/validate";
import { rateLimitByKey } from "../../middleware/rate-limit-key";
import { resolveProjectId } from "../../lib/resolve-project-id";
import { reviewPayload } from "./_helpers";
import { resolveChainEventFields } from "../../lib/chain-event-context";
import type { ReviewRouteDeps } from "./_deps";

// HOTL monitoring gate terminal endpoints.
//
// Dedicated endpoints — NOT the legacy decide/action pipeline — because that
// surface accepts api-key actors, maps every non-rejected decision to
// approve, and lets api-key callers spoof decided_by via body.reviewer.
// Monitoring outcomes are human-only attestations; reusing the legacy surface
// would let the agent that created the review confirm it under a fake human
// name, poisoning the veto-rate metric that is this feature's product.
//
// Exactly-once terminal transition: the UPDATE's WHERE asserts BOTH
// status = 'monitoring' AND expires_at > NOW() in the same statement
// (transactionally exact window boundary — a check-then-act split would let
// a veto commit seconds after expiry under load). Webhook + audit fire ONLY
// on a non-zero-row result. Pattern: closeMaxIterations in timeout-worker.ts,
// NOT processOne (which lacks the status re-assert and would reopen the
// veto-clobber race, this feature's worst failure mode).
// held_by is deliberately NOT checked: you do not queue behind a soft lock
// while an undo clock runs.

type ReviewRow = typeof reviewsTable.$inferSelect;

function requireHumanSession(req: unknown): { email: string } {
  const r = req as { authType?: string; reviewer?: { email?: string } };
  if (r.authType !== "session" || !r.reviewer?.email) {
    throw new ForbiddenError(
      "Monitoring reviews require a human session to veto or confirm.",
      "human_actor_required",
    );
  }
  return { email: r.reviewer.email };
}

// Zero-row disambiguation: window closed, already decided, or never a
// monitoring review? Read the row once and answer honestly.
async function throwZeroRowReason(
  deps: ReviewRouteDeps,
  reviewId: string,
  projectId: string,
): Promise<never> {
  const [row] = await deps.db
    .select({
      status: reviewsTable.status,
      decided_by: reviewsTable.decided_by,
      oversight: reviewsTable.oversight,
    })
    .from(reviewsTable)
    .where(and(eq(reviewsTable.id, reviewId), eq(reviewsTable.project_id, projectId)))
    .limit(1);
  if (!row) throw new NotFoundError("Review not found", "review_not_found");
  if (row.status === "monitoring") {
    // Still in-window status but the CAS failed → expires_at has passed and
    // the worker has not swept yet. The boundary is server-authoritative.
    throw new ConflictError("The veto window has closed.", "window_closed");
  }
  if (row.oversight === "monitoring") {
    throw new ConflictError(
      `Review already decided by ${row.decided_by || "another reviewer"}`,
      "review_already_decided",
    );
  }
  throw new ConflictError(
    "This review is not a monitoring gate.",
    "review_not_monitoring",
  );
}

// Fetch the project's HMAC secret for webhook signing. Returns null when the
// project has been deleted mid-flight (race handled by callers). Called
// BEFORE the CAS UPDATE — the secret is stable, and prefetching means no
// throwing await stands between a committed terminal transition and the 200
// response (a wasted query on CAS-loser requests is acceptable).
async function getHmacSecret(deps: ReviewRouteDeps, projectId: string): Promise<string | null> {
  const [proj] = await deps.db
    .select({ hmac_secret: projects.hmac_secret })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!proj) {
    console.error("monitoring: project not found during HMAC lookup", { projectId });
    return null;
  }
  return proj.hmac_secret;
}

type TerminalOutcome =
  | { kind: "vetoed"; note?: string }
  | { kind: "confirmed" };

// Post-CAS side effects for a committed terminal transition: audit log,
// agent webhook, and SSE event-bus emit. This helper NEVER throws — the CAS
// has already committed, so a failure in any side effect must not turn a
// successful veto/confirm into a 500 (the caller sends the 200 envelope
// unconditionally after this returns). Failures are logged with review_id.
// The webhook send itself is additionally fire-and-forget with its own
// .catch, so a slow agent callback can never block the response either.
async function fireTerminalSideEffects(
  deps: ReviewRouteDeps,
  args: {
    updated: ReviewRow;
    projectId: string;
    email: string;
    decidedAt: Date;
    hmacSecret: string | null;
    requestId?: string;
    outcome: TerminalOutcome;
  },
): Promise<void> {
  const { db, webhooks, auditService, eventBus } = deps;
  const { updated, projectId, email, decidedAt, hmacSecret, requestId, outcome } = args;
  try {
    // Audit: fire-and-forget
    auditService
      ?.log({
        action: outcome.kind === "vetoed" ? "review.vetoed" : "review.confirmed",
        actor: `reviewer:${email}`,
        resource_type: "review",
        resource_id: updated.id,
        details:
          outcome.kind === "vetoed" ? { note: outcome.note ?? null } : { lapsed: false },
        project_id: projectId,
      })
      .catch(() => {});

    // Webhook: gated on callback_url + project HMAC secret (prefetched by
    // the handler before the CAS).
    if (updated.callback_url && hmacSecret !== null) {
      if (outcome.kind === "vetoed") {
        webhooks
          .sendVetoed({
            callback_url: updated.callback_url,
            hmac_secret: hmacSecret,
            review_id: updated.id,
            vetoed_at: decidedAt.toISOString(),
            vetoed_by: email,
            note: outcome.note,
            request_id: requestId,
          })
          .catch((err: unknown) =>
            console.error("veto webhook failed", { review_id: updated.id, err }),
          );
      } else {
        webhooks
          .sendConfirmed({
            callback_url: updated.callback_url,
            hmac_secret: hmacSecret,
            review_id: updated.id,
            confirmed_at: decidedAt.toISOString(),
            decided_by: email,
            lapsed: false,
            request_id: requestId,
          })
          .catch((err: unknown) =>
            console.error("confirm webhook failed", { review_id: updated.id, err }),
          );
      }
    }

    // Event bus: emit with chain context when chain-attached.
    const chainCtx = updated.chain_run_id
      ? await resolveChainEventFields(db, updated.chain_run_id, updated.chain_step_id)
      : null;
    const base = {
      review_id: updated.id,
      template: updated.template_slug,
      project_id: projectId,
      priority: updated.priority as Priority,
      created_at: updated.created_at.toISOString(),
      ...(chainCtx ?? {}),
    };
    if (outcome.kind === "vetoed") {
      eventBus?.emit("review.vetoed", {
        ...base,
        vetoed_at: decidedAt.toISOString(),
        vetoed_by: email,
        // note only when present — mirrors the webhook payload, which omits
        // the key for note-less vetoes. Both surfaces stay consistent.
        ...(outcome.note ? { note: outcome.note } : {}),
      });
    } else {
      eventBus?.emit("review.confirmed", {
        ...base,
        confirmed_at: decidedAt.toISOString(),
        decided_by: email,
        lapsed: false,
      });
    }
  } catch (err) {
    // A committed terminal attestation must never 500. Log loudly and let
    // the handler return its 200; the webhook delivery row (if the send got
    // that far) still retries via the standard pipeline.
    console.error("monitoring: terminal side-effects failed after committed CAS", {
      review_id: updated.id,
      err,
    });
  }
}

export function createReviewMonitoringRoutes(deps: ReviewRouteDeps): Router {
  const router = Router();
  const { db } = deps;

  // POST /:id/veto — human-only; CAS update status=monitoring+window-open →
  // decided/vetoed. Stores the optional note in reviews.feedback.
  router.post(
    "/:id/veto",
    requireScope("reviews:decide"),
    rateLimitByKey(),
    validate({ body: ReviewVetoBodySchema }),
    async (req, res, next) => {
      try {
        // requireHumanSession FIRST — api-key callers get 403 before we touch
        // the DB, so they get an honest error instead of a misleading 404.
        const { email } = requireHumanSession(req);

        const reviewId = String(req.params.id);
        const projectId = await resolveProjectId(req, db, reviewId);
        if (!projectId) throw new NotFoundError("Review not found", "review_not_found");

        // Prefetch BEFORE the CAS so no throwing await stands between a
        // committed veto and the 200 response.
        const hmacSecret = await getHmacSecret(deps, projectId);

        const { note } = req.body as { note?: string };
        const decidedAt = new Date();

        // Exactly-once CAS: status must be 'monitoring' AND expires_at > NOW().
        // Also clears any stale worker lease (claimed_by/claimed_at) in the
        // same atomic statement.
        const [updated] = await db
          .update(reviewsTable)
          .set({
            status: "decided",
            decision: "vetoed",
            decided_by: email,
            decided_at: decidedAt,
            feedback: note ?? null,
            updated_at: new Date(),
            claimed_by: null,
            claimed_at: null,
          })
          .where(
            and(
              eq(reviewsTable.id, reviewId),
              eq(reviewsTable.project_id, projectId),
              eq(reviewsTable.status, "monitoring"),
              sql`${reviewsTable.expires_at} > NOW()`,
            ),
          )
          .returning();

        if (!updated) {
          await throwZeroRowReason(deps, reviewId, projectId);
        }

        // Never throws — see helper contract.
        await fireTerminalSideEffects(deps, {
          updated,
          projectId,
          email,
          decidedAt,
          hmacSecret,
          requestId: (req as any).requestId,
          outcome: { kind: "vetoed", note },
        });

        return res.json(
          envelope("review", {
            ...reviewPayload(updated),
            iteration_count: updated.current_version - 1,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /:id/confirm — human-only; CAS update status=monitoring+window-open →
  // decided/confirmed. No body required.
  router.post(
    "/:id/confirm",
    requireScope("reviews:decide"),
    rateLimitByKey(),
    async (req, res, next) => {
      try {
        const { email } = requireHumanSession(req);

        const reviewId = String(req.params.id);
        const projectId = await resolveProjectId(req, db, reviewId);
        if (!projectId) throw new NotFoundError("Review not found", "review_not_found");

        // Prefetch BEFORE the CAS so no throwing await stands between a
        // committed confirm and the 200 response.
        const hmacSecret = await getHmacSecret(deps, projectId);

        const decidedAt = new Date();

        const [updated] = await db
          .update(reviewsTable)
          .set({
            status: "decided",
            decision: "confirmed",
            decided_by: email,
            decided_at: decidedAt,
            updated_at: new Date(),
            claimed_by: null,
            claimed_at: null,
          })
          .where(
            and(
              eq(reviewsTable.id, reviewId),
              eq(reviewsTable.project_id, projectId),
              eq(reviewsTable.status, "monitoring"),
              sql`${reviewsTable.expires_at} > NOW()`,
            ),
          )
          .returning();

        if (!updated) {
          await throwZeroRowReason(deps, reviewId, projectId);
        }

        // Never throws — see helper contract.
        await fireTerminalSideEffects(deps, {
          updated,
          projectId,
          email,
          decidedAt,
          hmacSecret,
          requestId: (req as any).requestId,
          outcome: { kind: "confirmed" },
        });

        return res.json(
          envelope("review", {
            ...reviewPayload(updated),
            iteration_count: updated.current_version - 1,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

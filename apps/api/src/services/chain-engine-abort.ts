import { eq, and, inArray, isNotNull, exists, sql } from "drizzle-orm";
import { chainRuns, chainSteps, reviews } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import type { WebhookService } from "./webhooks";
import type { createAuditService } from "./audit";
import type { EventData } from "./events";
import { scrubAssigneeSpecPii } from "./chain-engine-token-resolution";

// Guarded next-step activation flip, atomic w.r.t. run status (no TOCTOU).
// DOUBLY GUARDED: (1) the step is still 'pending' (not concurrently skipped by
// abort) AND (2) EXISTS(run still active) evaluated AT the UPDATE instant. The
// EXISTS closes what the stale chainRunStillActive early-bail (FIX A) can't and
// the branch path defeats — branchToStep resets the target approved→pending
// AFTER abort's skip passed over it, so a status-only guard would re-activate it
// under an aborted run. Generates `... AND EXISTS (SELECT 1 FROM chain_runs
// WHERE id=? AND status='active')`. Returns true iff the flip committed (the
// run was active at the instant of the UPDATE); on false the caller closes the
// orphaned review.
export async function flipStepActiveGuarded(
  db: AppDb,
  args: { stepRowId: string; chainRunId: string; reviewId: string; at: Date },
): Promise<boolean> {
  const [flipped] = await db
    .update(chainSteps)
    .set({ review_id: args.reviewId, status: "active", materialized_at: args.at })
    .where(
      and(
        eq(chainSteps.id, args.stepRowId),
        eq(chainSteps.status, "pending"),
        exists(
          db
            .select({ one: sql`1` })
            .from(chainRuns)
            .where(and(eq(chainRuns.id, args.chainRunId), eq(chainRuns.status, "active"))),
        ),
      ),
    )
    .returning();
  return Boolean(flipped);
}

// Operator-abort module (Task 2).
//
// Extracted from chain-engine.ts to keep that file under the 600-line hard cap
// (mirrors the pattern of chain-rejection.ts / chain-engine-token-resolution.ts).
//
// abortRunImpl atomically force-stops an active chain run:
//   1. UPDATE chain_runs SET status='aborted', completed_at=now WHERE id=? AND status='active' RETURNING
//      → if 0 rows returned, run is either not found or already terminal → caller maps to 404/409.
//   2. UPDATE chain_steps SET status='skipped' WHERE chain_run_id=? AND status IN ('pending','active') RETURNING
//   3. Audit log chain.aborted (best-effort, fire-and-forget).
//   4. Resolve anchor review: active step first, then first materialized step.
//   5. If anchor review has callback_url + project has hmac_secret → fire sendChainAborted (best-effort).

export interface AbortRunDeps {
  db: AppDb;
  webhooks: WebhookService;
  auditService?: ReturnType<typeof createAuditService>;
  getHmacSecret: (projectId: string) => Promise<string | null>;
}

// Re-read run status fresh from the DB. EventBus emits are fire-and-forget
// (handlers are .catch-attached, never awaited), so a concurrent POST
// /chain-runs/:id/abort can flip a run to 'aborted' AFTER an in-flight
// onReviewDecided read it as 'active' but BEFORE it advances. Every advance /
// re-materialise path must gate on this so abort + advance can't race into an
// orphan (a 'skipped' step resurrected to 'active' + a fresh review under an
// 'aborted' run). Shared by ChainEngine (handleApprove/handleReject) and the
// rejection dispatcher (continue/branch). Returns false (and warns) when the
// run is gone or no longer active.
export async function chainRunStillActive(db: AppDb, runId: string): Promise<boolean> {
  const [fresh] = await db
    .select({ status: chainRuns.status })
    .from(chainRuns)
    .where(eq(chainRuns.id, runId))
    .limit(1);
  if (!fresh || fresh.status !== "active") {
    console.warn("ChainEngine advance skipped: run no longer active", {
      run_id: runId,
      status: fresh?.status,
    });
    return false;
  }
  return true;
}

// emitStepHalted — relocated from chain-engine.ts (private method) to keep
// that file under the 600-line hard cap. Same semantics; deps shape is
// identical to AbortRunDeps.
export async function emitStepHalted(
  deps: AbortRunDeps,
  data: EventData,
  err: unknown,
): Promise<void> {
  // Duck-type check: InvalidRequestError always sets .code; auth-tier codes
  // are the only "auth_level.*" codes in the system. Avoids relying on
  // instanceof (which can fail with Vitest's per-file module isolation).
  const errCode = (err as any)?.code;
  const isAuthLevel = typeof errCode === "string" && errCode.startsWith("auth_level.");
  const reason = isAuthLevel ? "auth_tier_invariant" : "materialize_error";
  const code = isAuthLevel ? (errCode as string) : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (deps.auditService) {
    await deps.auditService
      .log({
        action: "chain.step_halted",
        actor: "system:chain",
        resource_type: "chain_step",
        resource_id: data.review_id,
        details: { reason, ...(code ? { code } : {}), message },
        project_id: data.project_id,
      })
      .catch((e) =>
        console.error("chain.step_halted audit failed", { review_id: data.review_id, err: e }),
      );
  }
  try {
    const [rev] = await deps.db
      .select({ callback_url: reviews.callback_url, chain_run_id: reviews.chain_run_id })
      .from(reviews)
      .where(eq(reviews.id, data.review_id))
      .limit(1);
    if (rev?.callback_url && rev.chain_run_id) {
      const hmac = await deps.getHmacSecret(data.project_id);
      if (hmac !== null) {
        deps.webhooks
          .sendChainStepHalted({
            callback_url: rev.callback_url,
            hmac_secret: hmac,
            chain_run_id: rev.chain_run_id,
            review_id: data.review_id,
            reason,
            ...(code ? { code } : {}),
          })
          .catch((e) =>
            console.error("chain.step_halted webhook failed", { review_id: data.review_id, err: e }),
          );
      }
    }
  } catch (e) {
    console.error("chain.step_halted webhook failed", { review_id: data.review_id, err: e });
  }
}

// Open (non-terminal) review statuses an abort cancels. REVIEW_STATUSES has no
// 'active' member; the operator's open review(s) on a chain step sit in one of
// these states (pending on materialise, awaiting_* mid-iteration). They
// are flipped to 'expired' — the canonical closed-without-a-human-decision
// terminal state (same status the timeout path uses), so the abort leaves no
// review lingering in the inbox.
// 'monitoring' is unreachable via chains in v1 (chain steps pin oversight=blocking
// at materialization) but included so an abort can never strand a live veto window.
const OPEN_REVIEW_STATUSES = ["pending", "awaiting_iteration", "awaiting_external", "monitoring"] as const;
const CANCELLED_REVIEW_STATUS = "expired" as const;

export async function abortRunImpl(
  deps: AbortRunDeps,
  runId: string,
  projectId: string,
  actor: string,
): Promise<{ status: "aborted"; skipped: number } | null> {
  // Anchor review for the webhook: prefer the in-flight (active) step's review.
  // MUST be captured BEFORE the transaction below — the tx flips active→skipped,
  // destroying the "which step was active" information. The active step (when
  // present) is the one the operator was waiting on, so it is the most
  // meaningful delivery anchor.
  const [active] = await deps.db
    .select({ review_id: chainSteps.review_id })
    .from(chainSteps)
    .where(and(eq(chainSteps.chain_run_id, runId), eq(chainSteps.status, "active")))
    .limit(1);
  let anchorReviewId: string | null = active?.review_id ?? null;

  // ONE transaction: run-flip + step-skip + in-flight-review-cancel commit
  // together or not at all — no torn abort (a flipped run with un-skipped steps
  // or an open review left behind). The run-flip is the gate: 0 rows means the
  // run doesn't exist or isn't active, so we roll the whole tx back and signal
  // null (caller maps to 404 vs 409).
  const txResult = await deps.db.transaction(async (tx) => {
    const [run] = await tx
      .update(chainRuns)
      .set({ status: "aborted", completed_at: new Date() })
      .where(
        and(
          eq(chainRuns.id, runId),
          eq(chainRuns.project_id, projectId),
          eq(chainRuns.status, "active"),
        ),
      )
      .returning();
    if (!run) return null;

    const skipped = await tx
      .update(chainSteps)
      .set({ status: "skipped" })
      .where(
        and(
          eq(chainSteps.chain_run_id, runId),
          inArray(chainSteps.status, ["pending", "active"]),
        ),
      )
      .returning();

    // Cancel the operator's open review(s) so an aborted run leaves nothing
    // sitting in the inbox. Direct UPDATE emits no event → no chain feedback.
    await tx
      .update(reviews)
      .set({ status: CANCELLED_REVIEW_STATUS, updated_at: new Date() })
      .where(
        and(
          eq(reviews.chain_run_id, runId),
          inArray(reviews.status, [...OPEN_REVIEW_STATUSES]),
        ),
      );

    return { skipped: skipped.length };
  });

  if (txResult === null) return null;
  const skippedCount = txResult.skipped;

  // Everything past the commit is best-effort: audit + anchor/callback
  // resolution + webhook. A transient post-commit DB/secret error must NEVER
  // reject abortRunImpl — the flip is already durable, so the caller must
  // always see { status:"aborted", skipped }. Hence the whole tail is wrapped
  // in try/catch and each async send is .catch-attached.
  try {
    deps.auditService
      ?.log({
        action: "chain.aborted",
        actor,
        resource_type: "chain_run",
        resource_id: runId,
        details: { skipped_step_count: skippedCount },
        project_id: projectId,
      })
      .catch((e) => console.error("chain.aborted audit failed", { runId, err: e }));

    // Fallback: no active step (e.g. all steps already terminal but run was
    // still 'active'). Anchor on the first materialized step (lowest step_number
    // with a review_id). If no step is materialized, skip the webhook entirely.
    if (!anchorReviewId) {
      const [first] = await deps.db
        .select({ review_id: chainSteps.review_id })
        .from(chainSteps)
        .where(and(eq(chainSteps.chain_run_id, runId), isNotNull(chainSteps.review_id)))
        .orderBy(chainSteps.step_number)
        .limit(1);
      anchorReviewId = first?.review_id ?? null;
    }

    let anchorCallbackUrl: string | null = null;
    if (anchorReviewId) {
      const [rev] = await deps.db
        .select({ callback_url: reviews.callback_url })
        .from(reviews)
        .where(eq(reviews.id, anchorReviewId))
        .limit(1);
      anchorCallbackUrl = rev?.callback_url ?? null;
    }

    // C1: the step-1 review is the id the requester was handed at creation, so
    // it is what a consumer suspended against a review id can key on. The
    // anchor may be a later step (whichever was active when the abort landed).
    const [firstStep] = await deps.db
      .select({ review_id: chainSteps.review_id })
      .from(chainSteps)
      .where(and(eq(chainSteps.chain_run_id, runId), eq(chainSteps.step_number, 1)))
      .limit(1);

    if (anchorReviewId && anchorCallbackUrl) {
      const hmac = await deps.getHmacSecret(projectId);
      if (hmac !== null) {
        deps.webhooks
          .sendChainAborted({
            callback_url: anchorCallbackUrl,
            hmac_secret: hmac,
            chain_run_id: runId,
            anchor_review_id: anchorReviewId,
            initial_review_id: firstStep?.review_id ?? null,
            aborted_by: actor,
            skipped_step_count: skippedCount,
          })
          .catch((e) => console.error("chain.aborted webhook failed", { runId, err: e }));
      }
    }
  } catch (e) {
    console.error("chain.aborted post-commit best-effort failed", { runId, err: e });
  }

  return { status: "aborted", skipped: skippedCount };
}

// Extracted from chain-engine.ts (600 LOC cap). Builds the per-step
// transcript used by chain.completed + chain.rejected webhook payloads.
// Only needs db — no other engine state; safe to call from any context.
export async function buildTranscriptImpl(
  db: AppDb,
  chainRunId: string,
): Promise<Array<Record<string, unknown>>> {
  const steps = await db
    .select()
    .from(chainSteps)
    .where(eq(chainSteps.chain_run_id, chainRunId))
    .orderBy(chainSteps.step_number);

  const transcript: Array<Record<string, unknown>> = [];
  for (const step of steps) {
    if (!step.review_id) continue;
    const [review] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, step.review_id))
      .limit(1);
    if (!review) continue;

    const startMs = review.created_at.getTime();
    const endMs = review.decided_at ? review.decided_at.getTime() : Date.now();
    const scrubbedSpec = scrubAssigneeSpecPii(step.assignee_spec);
    transcript.push({
      step_id: step.id,
      step_number: step.step_number,
      review_id: review.id,
      assignee: scrubbedSpec,
      decision: review.decision,
      decided_by: review.decided_by,
      decided_at: review.decided_at ? review.decided_at.toISOString() : null,
      feedback: review.feedback,
      duration_seconds: Math.round((endMs - startMs) / 1000),
    });
  }
  return transcript;
}

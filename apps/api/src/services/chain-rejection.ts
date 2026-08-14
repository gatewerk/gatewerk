import { eq, and, gt, lte } from "drizzle-orm";
import {
  chainRuns,
  chainSteps,
  reviews,
} from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import type { ChainDefinitionStep, Priority } from "@gatewerk/shared";
import type { WebhookService } from "./webhooks";
import type { createAuditService } from "./audit";
import type { EventBus } from "./events";
import { chainRunStillActive } from "./chain-engine-abort";
import { chainOwnerEmail } from "./chain-engine-owner";

// M13 per-step rejection policy dispatcher. Kept in its own module so
// `chain-engine.ts` stays under the 600-line architectural cap; the engine
// delegates `handleReject` to `applyStepRejection` here.
//
// Three dispositions — default is 'abort' (preserves M10 terminate
// semantics for chain_steps rows that don't carry a policy):
//
//   abort    — mark chain_runs.status='rejected', fire chain.rejected, stop.
//   continue — advance to step N+1 (materialise it, fire chain.next_step_ready)
//              or complete the chain if N was the last step.
//   branch   — reset intermediate steps to 'pending' and re-materialise the
//              branch target (`rejection_branch_to`). The rejected step
//              stays 'rejected' as permanent audit — retrying past it happens
//              via normal sequential advance when the re-materialised steps
//              cascade back up.
//
// Always fires `chain.step_rejected` after the policy is applied; the
// chain.rejected / chain.next_step_ready webhooks remain the authoritative
// lifecycle events, `step_rejected` is the per-transition hook that tells
// receivers which disposition was applied.

type ChainRunRow = typeof chainRuns.$inferSelect;
type ChainStepRow = typeof chainSteps.$inferSelect;
type ReviewRow = typeof reviews.$inferSelect;

export type AppliedPolicy = "abort" | "continue" | "branch";

export interface MaterializeStepArgs {
  chainRunId: string;
  stepRowId: string;
  stepNumber: number;
  stepDefinition: ChainDefinitionStep;
  payload: Record<string, unknown>;
  prevReviewId: string | null;
  callbackUrl: string | null;
  projectId: string;
  /** C1: the route's entry template. Every step materialises against it. */
  entryTemplateSlug: string;
  fireNextStepWebhook: boolean;
}

export type MaterializeStepFn = (args: MaterializeStepArgs) => Promise<ReviewRow>;

export interface ChainRejectionDeps {
  db: AppDb;
  webhooks: WebhookService;
  eventBus: EventBus;
  auditService?: ReturnType<typeof createAuditService>;
  /**
   * C1: resolves the route's entry template slug. A THUNK, not a value: only
   * the continue and branch paths re-materialise a step and need it, while the
   * default policy (abort) re-materialises nothing. Resolving eagerly made
   * every rejection depend on a template lookup that abort has no use for, and
   * a throw there strands the run permanently — the step is already claimed
   * 'rejected' by the time this runs.
   */
  entryTemplateSlug: () => Promise<string>;
  materializeStep: MaterializeStepFn;
  buildTranscript: (chainRunId: string) => Promise<Array<Record<string, unknown>>>;
  getHmacSecret: (projectId: string) => Promise<string | null>;
  reconstructStepDefinition: (step: ChainStepRow) => ChainDefinitionStep;
  completeRun: (run: ChainRunRow, finalReview: ReviewRow) => Promise<void>;
}

/**
 * Top-level policy application. The caller flips the rejected step's status
 * to 'rejected' before invocation; this function handles everything else
 * (chain state, re-materialisation, webhooks).
 */
export async function applyStepRejection(
  deps: ChainRejectionDeps,
  run: ChainRunRow,
  currentStep: ChainStepRow,
  currentReview: ReviewRow,
): Promise<void> {
  const policy = resolvePolicy(currentStep);

  // Re-read run status fresh before any re-materialising path (continue/branch).
  // EventBus emits are fire-and-forget, so a concurrent POST /abort can flip
  // the run to 'aborted' between onReviewDecided's read and here. branchToStep
  // in particular resets intermediate steps to 'pending' and re-materialises —
  // without this guard it would resurrect 'skipped' steps under an 'aborted'
  // run. The rejected step stays 'rejected' (the human decided pre-abort); we
  // only stop further progression. (The guarded flip in materializeStep is the
  // backstop for the narrow window after this recheck.)
  if (policy === "continue") {
    if (!(await chainRunStillActive(deps.db, run.id))) return;
    const nextStepNumber = await continueToNextStep(deps, run, currentStep, currentReview);
    await fireStepRejected(deps, run, currentStep, currentReview, "continue", nextStepNumber);
    return;
  }

  if (policy === "branch") {
    if (!(await chainRunStillActive(deps.db, run.id))) return;
    const target = await branchToStep(deps, run, currentStep, currentReview);
    await fireStepRejected(deps, run, currentStep, currentReview, "branch", target);
    return;
  }

  await abortChain(deps, run, currentStep, currentReview);
  await fireStepRejected(deps, run, currentStep, currentReview, "abort", null);
}

function resolvePolicy(step: ChainStepRow): AppliedPolicy {
  const raw = step.rejection_policy;
  if (raw === "continue" || raw === "branch" || raw === "abort") return raw;
  return "abort";
}

// --- abort --------------------------------------------------------------

async function abortChain(
  deps: ChainRejectionDeps,
  run: ChainRunRow,
  currentStep: ChainStepRow,
  currentReview: ReviewRow,
): Promise<void> {
  const rejectedAt = new Date();
  // Guarded terminal write (atomic w.r.t. run status): a concurrent
  // POST /chain-runs/:id/abort can commit status='aborted' AFTER the
  // chainRunStillActive recheck in applyStepRejection but BEFORE this UPDATE.
  // WHERE status='active' makes abort win — 0 rows → bail before emitting a
  // misleading chain.rejected audit + webhook over an already-aborted run.
  const [terminalized] = await deps.db
    .update(chainRuns)
    .set({ status: "rejected", completed_at: rejectedAt })
    .where(and(eq(chainRuns.id, run.id), eq(chainRuns.status, "active")))
    .returning();
  if (!terminalized) return;

  if (deps.auditService) {
    await deps.auditService.log({
      action: "chain.rejected",
      actor: currentReview.decided_by || "system:chain",
      resource_type: "chain_run",
      resource_id: run.id,
      project_id: run.project_id,
      details: {
        rejecting_step_id: currentStep.id,
        rejecting_step_number: currentStep.step_number,
        rejection_policy: run.rejection_policy,
        applied_step_policy: "abort",
        rejected_at: rejectedAt.toISOString(),
      },
    }).catch((err) => console.error("chain.rejected audit failed", { runId: run.id, err }));
  }

  if (currentReview.callback_url) {
    const hmacSecret = await deps.getHmacSecret(run.project_id);
    if (hmacSecret !== null) {
      const transcript = await deps.buildTranscript(run.id);
      // C1: the step-1 review, which is the id the requester holds. The
      // rejecting step may be any step in the route.
      const [firstStep] = await deps.db
        .select({ review_id: chainSteps.review_id })
        .from(chainSteps)
        .where(and(eq(chainSteps.chain_run_id, run.id), eq(chainSteps.step_number, 1)))
        .limit(1);
      deps.webhooks.sendChainRejected({
        callback_url: currentReview.callback_url,
        hmac_secret: hmacSecret,
        chain_run_id: run.id,
        initial_review_id: firstStep?.review_id ?? null,
        rejected_at: rejectedAt.toISOString(),
        rejection_policy: run.rejection_policy,
        rejecting_step_id: currentStep.id,
        rejecting_step_number: currentStep.step_number,
        rejecting_review_id: currentReview.id,
        rejection_feedback: currentReview.feedback,
        transcript,
      }).catch((err) => console.error("chain.rejected webhook failed", { runId: run.id, err }));
    }
  }

  // The bus emit fires for EVERY chain, including agent-started ones. It is
  // the SSE channel and, since C1 §5.1, the channel the SDK wait helpers use
  // to learn a route terminated — gating it on a human owner left exactly the
  // agent-started runs that need the signal without one. Mirrors completeRun.
  //
  // Only the notification TARGET is owner-dependent: an agent-started chain
  // has no human to tap, and the review's assignee here is the reviewer who
  // just rejected. PersonalNotifier drops a chain terminal event carrying no
  // notify_assignee rather than falling back to them.
  const chainOwner = chainOwnerEmail(run.created_by);
  deps.eventBus.emit("chain.rejected", {
    review_id: currentReview.id,
    template: currentReview.template_slug,
    project_id: run.project_id,
    priority: currentReview.priority as Priority,
    created_at: rejectedAt.toISOString(),
    ...(chainOwner ? { notify_assignee: chainOwner } : {}),
  });
}

// --- continue -----------------------------------------------------------

async function continueToNextStep(
  deps: ChainRejectionDeps,
  run: ChainRunRow,
  currentStep: ChainStepRow,
  currentReview: ReviewRow,
): Promise<number | null> {
  const rejectedAt = new Date();
  const [nextStep] = await deps.db
    .select()
    .from(chainSteps)
    .where(
      and(
        eq(chainSteps.chain_run_id, run.id),
        eq(chainSteps.step_number, currentStep.step_number + 1),
      ),
    )
    .limit(1);

  let nextStepNumber: number | null = null;

  if (!nextStep) {
    await deps.completeRun(run, currentReview);
  } else {
    const nextPayload = (currentReview.edited_payload as Record<string, unknown> | null)
      || (currentReview.payload as Record<string, unknown>);
    const stepDefinition = deps.reconstructStepDefinition(nextStep);

    await deps.materializeStep({
      chainRunId: run.id,
      stepRowId: nextStep.id,
      stepNumber: nextStep.step_number,
      stepDefinition,
      payload: nextPayload,
      prevReviewId: currentReview.id,
      callbackUrl: currentReview.callback_url,
      projectId: run.project_id,
      entryTemplateSlug: await deps.entryTemplateSlug(),
      fireNextStepWebhook: true,
    });

    nextStepNumber = nextStep.step_number;
  }

  if (deps.auditService) {
    await deps.auditService.log({
      action: "chain.step_rejected",
      actor: currentReview.decided_by || "system:chain",
      resource_type: "chain_run",
      resource_id: run.id,
      project_id: run.project_id,
      details: {
        rejecting_step_id: currentStep.id,
        rejecting_step_number: currentStep.step_number,
        applied_step_policy: "continue",
        next_step_number: nextStepNumber,
        rejected_at: rejectedAt.toISOString(),
      },
    }).catch((err) => console.error("chain.step_rejected audit failed", { runId: run.id, err }));
  }

  return nextStepNumber;
}

// --- branch -------------------------------------------------------------

async function branchToStep(
  deps: ChainRejectionDeps,
  run: ChainRunRow,
  currentStep: ChainStepRow,
  currentReview: ReviewRow,
): Promise<number> {
  const rejectedAt = new Date();
  const targetNumber = currentStep.rejection_branch_to;
  if (targetNumber === null || targetNumber === undefined) {
    throw new Error(
      `chain_steps.rejection_branch_to missing for branch policy (step ${currentStep.id})`,
    );
  }

  const [targetStep] = await deps.db
    .select()
    .from(chainSteps)
    .where(
      and(
        eq(chainSteps.chain_run_id, run.id),
        eq(chainSteps.step_number, targetNumber),
      ),
    )
    .limit(1);
  if (!targetStep) {
    throw new Error(
      `branch target step_number=${targetNumber} not found in chain_run ${run.id}`,
    );
  }

  // Reset every step from target+1 through the REJECTING step inclusive, so
  // the cascade of approvals after the branch-target re-approval naturally
  // re-executes all of them.
  //
  // The rejecting step must be included (`lte`, not `lt`). It previously stayed
  // at status='rejected' as "the permanent audit of what triggered the branch",
  // but that deadlocked the run: when the re-run cascade reached it,
  // handleApprove selects the next step purely by step_number
  // (chain-engine.ts:374-383) and materializeStep's flipStepActiveGuarded
  // requires status='pending' (chain-engine-abort.ts:29). A 'rejected' step
  // fails that guard, the flip silently returns false, and the run is left
  // active with NO active step — a state reconcileImpl cannot see, because it
  // only scans runs that HAVE an active step. Permanent, silent deadlock.
  //
  // Since the schema forces rejection_branch_to < step_number, this was
  // reachable from every possible branch configuration, not an edge case.
  //
  // The audit property is not lost: the `chain.step_rejected` row records the
  // rejection permanently, and the rejected review itself remains in the
  // reviews table carrying its chain_run_id.
  await deps.db
    .update(chainSteps)
    .set({ status: "pending", review_id: null, materialized_at: null })
    .where(
      and(
        eq(chainSteps.chain_run_id, run.id),
        gt(chainSteps.step_number, targetNumber),
        lte(chainSteps.step_number, currentStep.step_number),
      ),
    );

  // Reset the branch target itself to 'pending' so the GUARDED flip in
  // materializeStep (which requires status='pending' as the abort backstop)
  // matches — the target is currently 'approved' from its earlier approval.
  // Its prior review stays in the reviews table (audit + history); review_id
  // is repointed by materializeStep below. Done as a separate UPDATE from the
  // intermediate-step reset above so the target's distinct semantics are
  // explicit.
  await deps.db
    .update(chainSteps)
    .set({ status: "pending", review_id: null, materialized_at: null })
    .where(and(eq(chainSteps.chain_run_id, run.id), eq(chainSteps.id, targetStep.id)));

  // Re-materialise the branch target. The original approved review stays in
  // the reviews table (referenced by audit + history); chain_steps.review_id
  // is overwritten by materializeStep below to point at the new review.
  const stepDefinition = deps.reconstructStepDefinition(targetStep);
  const initialPayload = (targetStep.assignee_spec as { initial_payload?: Record<string, unknown> } | null)?.initial_payload
    || (currentReview.payload as Record<string, unknown>);

  await deps.materializeStep({
    chainRunId: run.id,
    stepRowId: targetStep.id,
    stepNumber: targetStep.step_number,
    stepDefinition,
    payload: initialPayload,
    prevReviewId: null, // branch is a non-linear restart; no linear ancestor
    callbackUrl: currentReview.callback_url,
    projectId: run.project_id,
    entryTemplateSlug: await deps.entryTemplateSlug(),
    fireNextStepWebhook: true,
  });

  if (deps.auditService) {
    await deps.auditService.log({
      action: "chain.step_rejected",
      actor: currentReview.decided_by || "system:chain",
      resource_type: "chain_run",
      resource_id: run.id,
      project_id: run.project_id,
      details: {
        rejecting_step_id: currentStep.id,
        rejecting_step_number: currentStep.step_number,
        applied_step_policy: "branch",
        branch_target: targetNumber,
        rejected_at: rejectedAt.toISOString(),
      },
    }).catch((err) => console.error("chain.step_rejected audit failed", { runId: run.id, err }));
  }

  return targetNumber;
}

// --- webhook ------------------------------------------------------------

async function fireStepRejected(
  deps: ChainRejectionDeps,
  run: ChainRunRow,
  currentStep: ChainStepRow,
  currentReview: ReviewRow,
  applied: AppliedPolicy,
  nextStepIndex: number | null,
): Promise<void> {
  if (!currentReview.callback_url) return;
  const hmacSecret = await deps.getHmacSecret(run.project_id);
  if (hmacSecret === null) return;

  deps.webhooks.sendChainStepRejected({
    callback_url: currentReview.callback_url,
    hmac_secret: hmacSecret,
    chain_run_id: run.id,
    step_index: currentStep.step_number,
    applied_policy: applied,
    next_step_index: nextStepIndex,
    rejecting_review_id: currentReview.id,
    rejection_feedback: currentReview.feedback,
  }).catch((err) => console.error("chain.step_rejected webhook failed", { runId: run.id, err }));
}

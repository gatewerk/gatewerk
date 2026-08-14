import { eq } from "drizzle-orm";
import type { AppDb } from "@gatewerk/db";
import {
  chainRuns,
  chainSteps,
  reviews,
} from "@gatewerk/db/src/schema/index";
import type { ChainDefinitionStep } from "@gatewerk/shared";
import type {
  ApiKeySubject,
  ChainStepAssignee,
  ChainStepSubject,
  SessionSubject,
} from "./subjects";

// Collapses a ChainDefinitionStep.assignee (user | role | external_token)
// into the policy-facing ChainStepAssignee shape. External tokens resolve
// to `null` because the /r/:token surface authenticates them out-of-band
// and the chain-step gate never gets a chance to match them positively.
// A `user` assignee without `email` (user_id only) collapses to `null` too —
// policy evaluation compares session.email, and id-only comparison is
// better handled as a chain-owner / admin path rather than an email match.
function collapseAssignee(assignee: ChainDefinitionStep["assignee"] | undefined): ChainStepAssignee | null {
  if (!assignee) return null;
  if (assignee.kind === "user" && assignee.email) {
    return { kind: "email", email: assignee.email };
  }
  if (assignee.kind === "role") {
    return { kind: "role", role: assignee.role };
  }
  return null;
}

/**
 * Promote a base subject (session or api_key) to a chain-step subject if
 * the given review belongs to an active chain run. Returns the original
 * requester unchanged when the review is not chain-attached or when the
 * chain context is missing/incoherent (preserves non-chain decide behavior
 * without forcing callers to branch). The promotion is always bounded to
 * a single wrap — ChainStepSubject.requester is narrowed to base subjects
 * by the type system.
 */
export async function buildChainAwareSubject(
  db: AppDb,
  reviewId: string,
  requester: ApiKeySubject | SessionSubject,
): Promise<ApiKeySubject | SessionSubject | ChainStepSubject> {
  const [review] = await db
    .select({
      chain_run_id: reviews.chain_run_id,
      chain_step_id: reviews.chain_step_id,
    })
    .from(reviews)
    .where(eq(reviews.id, reviewId))
    .limit(1);

  if (!review || !review.chain_run_id || !review.chain_step_id) {
    return requester;
  }

  const [run] = await db
    .select({
      id: chainRuns.id,
      created_by: chainRuns.created_by,
    })
    .from(chainRuns)
    .where(eq(chainRuns.id, review.chain_run_id))
    .limit(1);

  const [step] = await db
    .select({
      step_number: chainSteps.step_number,
      assignee_spec: chainSteps.assignee_spec,
    })
    .from(chainSteps)
    .where(eq(chainSteps.id, review.chain_step_id))
    .limit(1);

  if (!run || !step) {
    // Half-state: the review carries chain_run_id + chain_step_id linkage
    // but the corresponding chain_runs / chain_steps rows are missing (DB
    // corruption or a mid-delete race window). The old behaviour was to
    // fall through to the base requester (fail-OPEN) — this was a security
    // hole: a reviewer who somehow held the chain link ids would be granted
    // access as if the review were non-chain-attached.
    //
    // Task 3 / M11.2 CLOSED: return a ChainStepSubject with a sentinel
    // chain_owner_id that cannot match any real requester, so can()
    // denies everyone except session admins (who retain their bypass per
    // the chain-step gate's admin path — that's correct, not a hole).
    return {
      kind: "chain_step",
      review_id: reviewId,
      chain_run_id: review.chain_run_id,
      step_index: -1,
      step_assignee: null,
      chain_owner_id: "\x00chain_context_unavailable",
      requester,
    };
  }

  const stepDef = step.assignee_spec as unknown as ChainDefinitionStep | null;
  const stepAssignee = collapseAssignee(stepDef?.assignee);

  return {
    kind: "chain_step",
    review_id: reviewId,
    chain_run_id: run.id,
    step_index: step.step_number,
    step_assignee: stepAssignee,
    chain_owner_id: run.created_by,
    requester,
  };
}

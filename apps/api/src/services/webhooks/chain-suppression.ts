// Which review-level deliveries a chain withholds (C1, charter §5.1).
//
// A chain is a route of approvers over ONE request: every step reviews the
// same payload against the same template, so a step's approval is
// shape-identical to the final authorization. Neither review-level decision
// payload carries a chain id or a step position, so nothing on that wire tells
// them apart, and an agent keying on either would act after the first approver
// said yes and before the last one looked.
//
// The distinction is made by NOT sending them. An added chain field would be
// fail-OPEN: the integrator who never learns to read it still acts early.
// Silence cannot be misread. A chain announces each step with
// chain.step_decided and authorizes with chain.completed.
//
// Extracted from webhooks.ts to keep that file under the 600 LOC cap, and
// because "what a chain withholds" is one rule that both senders have to
// agree on rather than two lookalike guards.

/**
 * True when a `review.decided` delivery must be recorded but not sent.
 *
 * Every chain-attached review qualifies: this payload is the frozen v1
 * decision callback, and its whole meaning is "decided, act on it".
 */
export function suppressesReviewDecided(chainRunId: string | null): boolean {
  return chainRunId !== null && chainRunId !== undefined;
}

/**
 * True when a `review.action_taken` delivery must be recorded but not sent.
 *
 * Scoped to DECISION-kind actions. review.action_taken is the canonical v1.5
 * event and fires for every action, but only a decision can be mistaken for an
 * authorization. An iteration or side-effect action on a chain step still goes
 * out, because "the agent must revise" is not an authorization and cannot be
 * read as one.
 */
export function suppressesActionTaken(
  chainRunId: string | null,
  actionKind: string | null,
): boolean {
  return suppressesReviewDecided(chainRunId) && actionKind === "decision";
}

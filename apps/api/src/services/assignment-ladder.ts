import { InvalidRequestError } from "@gatewerk/shared";
import type { AssignmentLadder, AssignmentLadderStep } from "@gatewerk/shared";

// Assignment ladder service (M9 Phase 1). Three pure functions that turn a
// client-supplied ladder spec into DB column values at create time and walk
// the ladder forward during TimeoutWorker-driven promotion. Keeping these
// pure lets the worker own claim semantics and transactions while this
// module stays trivially unit-testable.
//
// Invariants shared by every function:
//   * `ladder[0]` is always `active`.
//   * All other steps start `pending` and become `active` exactly once
//     before transitioning to `promoted`.
//   * `trigger_after_seconds` is cumulative from review creation; index 1
//     fires first, then index 2, etc. The value at index 0 is recorded for
//     audit symmetry but never triggers a promotion.
//   * `ladder_next_promote_at` points at the step AFTER the currently-active
//     one; it is null when the ladder has reached its terminal step.

export const MIN_TRIGGER_AFTER_SECONDS = 60;

type NormalisedStep = Required<Pick<AssignmentLadderStep, "actor" | "trigger_after_seconds" | "status">>;

export type InitLadderResult = {
  ladder: NormalisedStep[];
  ladder_index: 0;
  ladder_next_promote_at: Date | null;
  assignee: string;
};

export type PromoteLadderResult = {
  ladder: NormalisedStep[];
  ladder_index: number;
  ladder_next_promote_at: Date | null;
  previous_assignee: string;
  new_assignee: string;
};

export function validateLadder(ladder: unknown): asserts ladder is AssignmentLadder {
  if (!Array.isArray(ladder) || ladder.length === 0) {
    throw new InvalidRequestError(
      "assignment_ladder must be a non-empty array of steps",
      "assignment_ladder",
      "invalid_ladder",
    );
  }
  for (let i = 0; i < ladder.length; i++) {
    const step = ladder[i];
    if (!step || typeof step !== "object") {
      throw new InvalidRequestError(
        `assignment_ladder[${i}] must be an object`,
        "assignment_ladder",
        "invalid_ladder_step",
      );
    }
    const actor = (step as AssignmentLadderStep).actor;
    if (typeof actor !== "string" || actor.length === 0) {
      throw new InvalidRequestError(
        `assignment_ladder[${i}].actor must be a non-empty string`,
        "assignment_ladder",
        "invalid_ladder_actor",
      );
    }
    const trigger = (step as AssignmentLadderStep).trigger_after_seconds;
    if (typeof trigger !== "number" || !Number.isInteger(trigger) || trigger < MIN_TRIGGER_AFTER_SECONDS) {
      throw new InvalidRequestError(
        `assignment_ladder[${i}].trigger_after_seconds must be an integer >= ${MIN_TRIGGER_AFTER_SECONDS}`,
        "assignment_ladder",
        "invalid_ladder_trigger",
      );
    }
    if (i > 0) {
      const prev = (ladder[i - 1] as AssignmentLadderStep).trigger_after_seconds;
      if (trigger <= prev) {
        throw new InvalidRequestError(
          `assignment_ladder[${i}].trigger_after_seconds must be strictly greater than the previous step`,
          "assignment_ladder",
          "invalid_ladder_monotonicity",
        );
      }
    }
  }
}

export function initLadder(ladder: AssignmentLadder, createdAt: Date): InitLadderResult {
  validateLadder(ladder);
  const normalised: NormalisedStep[] = ladder.map((step, i) => ({
    actor: step.actor,
    trigger_after_seconds: step.trigger_after_seconds,
    status: i === 0 ? "active" : "pending",
  }));
  // First promotion fires at index 1 (step.trigger_after_seconds is cumulative
  // from `createdAt`, not from the previous step). null when the ladder is a
  // single step — there is nothing to promote to.
  const next = ladder.length > 1
    ? new Date(createdAt.getTime() + ladder[1].trigger_after_seconds * 1000)
    : null;
  return {
    ladder: normalised,
    ladder_index: 0,
    ladder_next_promote_at: next,
    assignee: ladder[0].actor,
  };
}

export function promoteLadder(review: {
  ladder_index: number;
  assignment_ladder: AssignmentLadder | null | undefined;
  created_at: Date;
}): PromoteLadderResult {
  const ladder = review.assignment_ladder;
  if (!Array.isArray(ladder) || ladder.length === 0) {
    throw new InvalidRequestError(
      "Cannot promote a review without an assignment_ladder",
      "assignment_ladder",
      "no_ladder",
    );
  }
  const currentIdx = review.ladder_index ?? 0;
  if (currentIdx < 0 || currentIdx >= ladder.length) {
    throw new InvalidRequestError(
      `ladder_index ${currentIdx} is out of bounds for ladder of length ${ladder.length}`,
      "ladder_index",
      "invalid_ladder_index",
    );
  }
  if (currentIdx >= ladder.length - 1) {
    throw new InvalidRequestError(
      "Cannot promote past the final ladder step",
      "assignment_ladder",
      "ladder_exhausted",
    );
  }

  const newIdx = currentIdx + 1;
  const updated: NormalisedStep[] = ladder.map((step, i) => ({
    actor: step.actor,
    trigger_after_seconds: step.trigger_after_seconds,
    status: i < newIdx ? "promoted" : i === newIdx ? "active" : "pending",
  }));

  // `ladder_next_promote_at` is the timer for the step AFTER the one we just
  // activated. Cumulative from `created_at` keeps the schedule independent of
  // drift between ticks (a delayed worker doesn't compress future windows).
  const nextStep = ladder[newIdx + 1];
  const nextPromoteAt = nextStep
    ? new Date(review.created_at.getTime() + nextStep.trigger_after_seconds * 1000)
    : null;

  return {
    ladder: updated,
    ladder_index: newIdx,
    ladder_next_promote_at: nextPromoteAt,
    previous_assignee: ladder[currentIdx].actor,
    new_assignee: ladder[newIdx].actor,
  };
}

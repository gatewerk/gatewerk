import { describe, it, expect } from "vitest";
import { toTileStatus, verdictLabel, stepWho } from "./ChainStepper";
import type { ChainStep } from "@gatewerk/web-core/api/reviews";

// C1 relay (charter §3). The pure parts of the stepper: what a step's status
// looks like, and what a prior decision reads as. The one thing these must
// never do is draw a finished route as though it were still waiting.

function step(overrides: Partial<ChainStep> = {}): ChainStep {
  return {
    id: "gw_chain_step_1",
    chain_run_id: "gw_chain_1",
    step_number: 1,
    review_id: null,
    assignee_spec: null,
    depends_on: null,
    status: "pending",
    materialized_at: null,
    rejection_policy: null,
    rejection_branch_to: null,
    token_status: null,
    decision: null,
    decided_by: null,
    decided_at: null,
    feedback: null,
    guidance: null,
    ...overrides,
  } as ChainStep;
}

describe("toTileStatus", () => {
  it("draws an approved step as done", () => {
    expect(toTileStatus("approved")).toBe("done");
    expect(toTileStatus("completed")).toBe("done");
  });

  it("draws a rejected step as rejected, not as still waiting", () => {
    // The defect this pins: 'rejected' used to fold into 'todo', so a chain
    // that had already stopped rendered a dim tile indistinguishable from a
    // step nobody had reached yet.
    expect(toTileStatus("rejected")).toBe("rejected");
    expect(toTileStatus("expired")).toBe("rejected");
  });

  it("draws the open step as active and everything unreached as todo", () => {
    expect(toTileStatus("active")).toBe("active");
    expect(toTileStatus("pending")).toBe("todo");
    expect(toTileStatus("skipped")).toBe("todo");
    expect(toTileStatus("superseded")).toBe("todo");
  });
});

describe("verdictLabel", () => {
  it("says nothing for a step that has not decided", () => {
    expect(verdictLabel(null)).toBeNull();
  });

  it("reads an approve-with-edits as an approval", () => {
    expect(verdictLabel("approved")).toBe("approved");
    expect(verdictLabel("edited")).toBe("approved");
  });

  it("names a rejection and an expiry plainly", () => {
    expect(verdictLabel("rejected")).toBe("rejected");
    expect(verdictLabel("expired")).toBe("expired without a decision");
  });

  it("passes an unknown decision through rather than inventing one", () => {
    expect(verdictLabel("max_iterations_reached")).toBe("max_iterations_reached");
  });
});

describe("stepWho", () => {
  it("names a person", () => {
    expect(
      stepWho(step({ assignee_spec: { assignee: { kind: "user", email: "alice@corp.co" } } })),
    ).toBe("alice@corp.co");
  });

  it("falls back to the kind when the API scrubbed a future step's identity", () => {
    // scrubFutureStepAssigneeSpec reduces a not-yet-reached step's assignee to
    // { kind } for a non-owner. The label degrades rather than going blank.
    expect(stepWho(step({ assignee_spec: { assignee: { kind: "external_token" } } }))).toBe(
      "external token",
    );
    expect(stepWho(step({ assignee_spec: { assignee: { kind: "role", role: "admin" } } }))).toBe(
      "role · admin",
    );
  });

  it("says nothing rather than guessing when there is no spec", () => {
    expect(stepWho(step())).toBe("");
  });
});

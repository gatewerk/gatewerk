import { describe, it, expect } from "vitest";
import { collectValidation } from "./action-editor-state";
import type { TemplateActionConfigCanonical } from "@gatewerk/shared";

// Pure-logic coverage for the ActionEditor list-level validation. The function
// answers two questions (1) does the list contain at least one decision
// action, and (2) are decision_values unique across all decision actions.

function decision(id: string, decision_value: "approved" | "rejected"): TemplateActionConfigCanonical {
  return { id, label: id, kind: "decision", decision_value, style: "primary" };
}

function iteration(id: string): TemplateActionConfigCanonical {
  return { id, label: id, kind: "iteration", style: "secondary" };
}

describe("collectValidation", () => {
  it("returns missing-decision message for empty list", () => {
    expect(collectValidation([])).toEqual(["At least 1 decision action required."]);
  });

  it("returns [] for one decision action", () => {
    expect(collectValidation([decision("approve", "approved")])).toEqual([]);
  });

  it("returns missing-decision for iteration-only list", () => {
    expect(collectValidation([iteration("changes")])).toEqual([
      "At least 1 decision action required.",
    ]);
  });

  it("flags duplicate approved decision_value", () => {
    const out = collectValidation([
      decision("approve_a", "approved"),
      decision("approve_b", "approved"),
    ]);
    expect(out).toEqual(["Decision values must be unique."]);
  });

  it("flags duplicate rejected decision_value", () => {
    const out = collectValidation([
      decision("reject_a", "rejected"),
      decision("reject_b", "rejected"),
    ]);
    expect(out).toEqual(["Decision values must be unique."]);
  });

  it("returns [] for approve + reject (different decision_values)", () => {
    expect(
      collectValidation([
        decision("approve", "approved"),
        decision("reject", "rejected"),
      ]),
    ).toEqual([]);
  });

  it("decision_value collision check ignores iteration kinds", () => {
    // Two iteration kinds with no decision_value field at all (kind=iteration
    // means decision_value is dropped at canonical-build time). Result is just
    // the missing-decision message — no false-positive uniqueness flag.
    const out = collectValidation([iteration("a"), iteration("b")]);
    expect(out).toEqual(["At least 1 decision action required."]);
  });
});

import { describe, it, expect } from "vitest";
import { filterTokenActions, withRecipientSafety } from "./token-actions-state";
import type { TemplateActionConfigCanonical } from "@gatewerk/shared";

const sampleAction = (
  overrides: Partial<TemplateActionConfigCanonical>,
): TemplateActionConfigCanonical => ({
  id: "sample",
  label: "Sample",
  kind: "decision",
  decision_value: "approved",
  style: "primary",
  enabled_for_status: ["pending"],
  requires_feedback: false,
  confirmation: false,
  expose_to_recipient: true,
  order: 0,
  ...overrides,
});

describe("filterTokenActions", () => {
  it("filters out non-decision kinds (iteration, side_effect)", () => {
    const result = filterTokenActions([
      sampleAction({ id: "approve", kind: "decision", decision_value: "approved" }),
      sampleAction({
        id: "request_changes",
        kind: "iteration",
        decision_value: undefined,
      }),
      sampleAction({
        id: "cancel_iteration",
        kind: "side_effect",
        decision_value: undefined,
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("approve");
  });

  it("filters out actions with expose_to_recipient: false", () => {
    const result = filterTokenActions([
      sampleAction({ id: "approve", expose_to_recipient: true }),
      sampleAction({ id: "internal_only", expose_to_recipient: false }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("approve");
  });

  it("treats undefined expose_to_recipient as true (default visible)", () => {
    const result = filterTokenActions([
      sampleAction({ id: "approve", expose_to_recipient: undefined }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("approve");
  });

  it("filters out decision-kind actions missing decision_value (defensive)", () => {
    const result = filterTokenActions([
      sampleAction({ id: "broken", kind: "decision", decision_value: undefined }),
      sampleAction({ id: "approve", kind: "decision", decision_value: "approved" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("approve");
  });

  it("preserves order from input", () => {
    const result = filterTokenActions([
      sampleAction({ id: "reject", decision_value: "rejected" }),
      sampleAction({ id: "approve", decision_value: "approved" }),
    ]);
    expect(result.map((a) => a.id)).toEqual(["reject", "approve"]);
  });

  it("falls back to canonical approve+reject when filtered list is empty", () => {
    const result = filterTokenActions([]);
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.id)).toEqual(["approve", "reject"]);
    expect(result[0]?.kind).toBe("decision");
    expect(result[0]?.decision_value).toBe("approved");
    expect(result[1]?.decision_value).toBe("rejected");
  });

  it("returns empty when all actions are non-decision (respects author intent — no auto-inject)", () => {
    const result = filterTokenActions([
      sampleAction({
        id: "request_changes",
        kind: "iteration",
        decision_value: undefined,
      }),
    ]);
    expect(result).toEqual([]);
  });

  it("returns empty when all actions have expose_to_recipient: false (respects author intent)", () => {
    const result = filterTokenActions([
      sampleAction({ id: "approve", expose_to_recipient: false }),
      sampleAction({
        id: "reject",
        expose_to_recipient: false,
        decision_value: "rejected",
      }),
    ]);
    expect(result).toEqual([]);
  });

  it("returns visible subset when some authored actions filter out (mixed config)", () => {
    const result = filterTokenActions([
      sampleAction({ id: "approve", expose_to_recipient: true }),
      sampleAction({ id: "internal_only", expose_to_recipient: false }),
      sampleAction({
        id: "request_changes",
        kind: "iteration",
        decision_value: undefined,
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("approve");
  });
});

describe("withRecipientSafety", () => {
  it("forces confirmation: true on actions where it was undefined", () => {
    const result = withRecipientSafety([sampleAction({ confirmation: undefined })]);
    expect(result[0]?.confirmation).toBe(true);
  });

  it("forces confirmation: true on actions where it was false (override)", () => {
    const result = withRecipientSafety([sampleAction({ confirmation: false })]);
    expect(result[0]?.confirmation).toBe(true);
  });

  it("preserves confirmation: true when already set", () => {
    const result = withRecipientSafety([sampleAction({ confirmation: true })]);
    expect(result[0]?.confirmation).toBe(true);
  });

  it("preserves all other fields (id, label, kind, decision_value, style, etc.)", () => {
    const input = sampleAction({
      id: "custom",
      label: "Custom Label",
      kind: "decision",
      decision_value: "approved",
      style: "destructive",
    });
    const [output] = withRecipientSafety([input]);
    expect(output).toMatchObject({
      id: "custom",
      label: "Custom Label",
      kind: "decision",
      decision_value: "approved",
      style: "destructive",
      confirmation: true,
    });
  });
});

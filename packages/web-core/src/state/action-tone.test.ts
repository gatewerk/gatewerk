import { describe, it, expect } from "vitest";
import { actionTone } from "./action-tone";

describe("actionTone", () => {
  it("paints an approve decision green", () => {
    expect(actionTone({ kind: "decision", decision_value: "approved" })).toBe("green");
  });

  it("paints a reject decision red", () => {
    expect(actionTone({ kind: "decision", decision_value: "rejected" })).toBe("red");
  });

  it("leaves an iteration neutral", () => {
    expect(actionTone({ kind: "iteration" })).toBe("neutral");
  });

  it("leaves a side effect neutral", () => {
    expect(actionTone({ kind: "side_effect" })).toBe("neutral");
  });

  // The reason the axis exists: a custom action nobody could otherwise make
  // dangerous-looking.
  it("paints an explicitly destructive side effect red", () => {
    expect(actionTone({ kind: "side_effect", style: "destructive" })).toBe("red");
  });

  it("paints an explicitly destructive iteration red", () => {
    expect(actionTone({ kind: "iteration", style: "destructive" })).toBe("red");
  });

  it("lets destructive outrank an approved decision", () => {
    expect(
      actionTone({ kind: "decision", decision_value: "approved", style: "destructive" }),
    ).toBe("red");
  });

  // The other three enum values reach this function from the API. None of them
  // may quietly become a colour the reviewer cannot otherwise get.
  it("ignores the styles it does not speak", () => {
    expect(actionTone({ kind: "side_effect", style: "primary" })).toBe("neutral");
    expect(actionTone({ kind: "side_effect", style: "secondary" })).toBe("neutral");
    expect(actionTone({ kind: "side_effect", style: "warning" })).toBe("neutral");
  });

  it("does not let a primary style repaint a reject", () => {
    expect(
      actionTone({ kind: "decision", decision_value: "rejected", style: "primary" }),
    ).toBe("red");
  });

  it("tolerates null from an API shape", () => {
    expect(actionTone({ kind: "side_effect", style: null, decision_value: null })).toBe("neutral");
  });
});

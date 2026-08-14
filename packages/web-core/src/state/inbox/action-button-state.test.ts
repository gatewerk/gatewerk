import { describe, it, expect } from "vitest";
import {
  visibleLabel,
  widthPinLabel,
  variantClasses,
  STYLE_VARIANTS,
} from "./action-button-state";

// Pure-state coverage for the ActionButton visual derivation. The component
// itself (./ActionButton.tsx) is exercised end-to-end via Playwright since
// apps/web has no jsdom/RTL setup — this matches the precedent set by
// chain-step-indicator-helpers.test.ts and action-editor-modal-state.test.ts.

describe("visibleLabel", () => {
  it("returns the canonical label on idle", () => {
    expect(visibleLabel({ state: "idle", label: "Approve" })).toBe("Approve");
  });

  it("returns the canonical label on pending (spinner provides the busy hint)", () => {
    expect(visibleLabel({ state: "pending", label: "Reject" })).toBe("Reject");
  });

  it("returns 'Confirm?' on confirming regardless of label", () => {
    expect(visibleLabel({ state: "confirming", label: "Escalate" })).toBe("Confirm?");
  });

  it("returns successLabel on success when provided", () => {
    expect(
      visibleLabel({ state: "success", label: "Approve", successLabel: "Approved" }),
    ).toBe("Approved");
  });

  it("falls back to label on success when successLabel is omitted", () => {
    expect(visibleLabel({ state: "success", label: "Done" })).toBe("Done");
  });
});

describe("widthPinLabel", () => {
  it("returns the explicit longestLabel override when provided", () => {
    expect(widthPinLabel("A", "B", "Permanently delete")).toBe("Permanently delete");
  });

  it("picks successLabel when it is the longest of (label, successLabel, 'Confirm?')", () => {
    expect(widthPinLabel("Reject", "Rejected forever", undefined)).toBe(
      "Rejected forever",
    );
  });

  it("picks 'Confirm?' when both label and successLabel are shorter", () => {
    expect(widthPinLabel("Yes", "OK", undefined)).toBe("Confirm?");
  });

  it("treats successLabel=undefined as label for the comparison", () => {
    expect(widthPinLabel("Approve", undefined, undefined)).toBe("Confirm?");
  });
});

describe("variantClasses", () => {
  it("returns the idle variant for state=idle", () => {
    expect(variantClasses("primary", "idle")).toBe(STYLE_VARIANTS.primary.idle);
  });

  it("returns the confirming variant for state=confirming", () => {
    expect(variantClasses("destructive", "confirming")).toBe(
      STYLE_VARIANTS.destructive.confirming,
    );
  });

  it("returns the pending variant for state=pending", () => {
    expect(variantClasses("secondary", "pending")).toBe(STYLE_VARIANTS.secondary.pending);
  });

  it("returns the pending variant for state=success (visual continuity through the morph)", () => {
    expect(variantClasses("warning", "success")).toBe(STYLE_VARIANTS.warning.pending);
  });
});

describe("STYLE_VARIANTS", () => {
  it("uses theme tokens only (no hex / rgba literals)", () => {
    const all = Object.values(STYLE_VARIANTS).flatMap((v) => [
      v.idle,
      v.confirming,
      v.pending,
    ]);
    for (const cls of all) {
      expect(cls).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(cls).not.toMatch(/rgba?\(/);
    }
  });

  it("covers all 4 style keys (primary, destructive, secondary, warning)", () => {
    expect(Object.keys(STYLE_VARIANTS).sort()).toEqual([
      "destructive",
      "primary",
      "secondary",
      "warning",
    ]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeToCanonical } from "./_helpers";
import { DEFAULT_ACTION_PRESETS } from "@gatewerk/shared";

// Pure-logic coverage for normalizeToCanonical — the legacy action-shape
// reconciler. Three accepted input forms (canonical / bare-string preset /
// intermediate {type, label}) plus the dropped-with-warning fallbacks.
//
// All tests stub console.warn so the silent-drop assertions can be made
// without polluting test output.

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("normalizeToCanonical", () => {
  it("returns [] for non-array input", () => {
    expect(normalizeToCanonical(null)).toEqual([]);
    expect(normalizeToCanonical(undefined)).toEqual([]);
    expect(normalizeToCanonical("approve")).toEqual([]);
    expect(normalizeToCanonical({ id: "approve" })).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(normalizeToCanonical([])).toEqual([]);
  });

  it("passes through already-canonical actions and preserves extra fields", () => {
    const input = [
      {
        id: "approve",
        label: "Approve",
        kind: "decision" as const,
        decision_value: "approved" as const,
        style: "primary" as const,
        enabled_for_status: ["pending", "awaiting_external"],
      },
    ];
    const out = normalizeToCanonical(input);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "approve",
      label: "Approve",
      kind: "decision",
      decision_value: "approved",
      enabled_for_status: ["pending", "awaiting_external"],
    });
  });

  it("expands bare-string approve preset with order 0", () => {
    const out = normalizeToCanonical(["approve"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ ...DEFAULT_ACTION_PRESETS.approve, order: 0 });
  });

  it("expands bare-string reject at index 1 with order 1", () => {
    const out = normalizeToCanonical(["approve", "reject"]);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ ...DEFAULT_ACTION_PRESETS.reject, order: 1 });
  });

  it("drops unknown bare-string and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = normalizeToCanonical(["mystery"]);
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("Dropped unknown bare-string action");
    expect(warn.mock.calls[0][0]).toContain("mystery");
  });

  it("expands intermediate {type, label} with custom label and order", () => {
    const out = normalizeToCanonical([{ type: "approve", label: "OK!" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ ...DEFAULT_ACTION_PRESETS.approve, label: "OK!", order: 0 });
  });

  it("drops intermediate {type} with unknown type and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = normalizeToCanonical([{ type: "ghost" }]);
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("Dropped legacy action with unknown type");
    expect(warn.mock.calls[0][0]).toContain("ghost");
  });

  it("preserves kept items in input order across mixed array", () => {
    const canonical = {
      id: "custom",
      label: "Custom",
      kind: "side_effect" as const,
      style: "secondary" as const,
    };
    const out = normalizeToCanonical([
      "approve",
      canonical,
      { type: "reject", label: "Nope" },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].id).toBe("approve");
    expect(out[1].id).toBe("custom");
    expect(out[2].id).toBe("reject");
    expect(out[2].label).toBe("Nope");
  });
});

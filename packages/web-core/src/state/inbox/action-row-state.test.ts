import { describe, it, expect } from "vitest";
import {
  filterEnabled,
  sortStable,
  sliceInlineOverflow,
  resolveVisibleActions,
  kindToOptimisticPatch,
  isKnownIcon,
  successLabelFor,
  withSystemDefaults,
  INLINE_LIMIT,
} from "./action-row-state";
import type {
  TemplateActionConfigCanonical,
  ReviewStatus,
} from "@gatewerk/shared";

// Pure-state coverage for ActionRow's filter / sort / overflow split + the
// optimistic-patch derivation. Component-rendering coverage (DropdownMenu
// kebab open, button disabled state during mutation) is exercised end-to-end
// via Playwright since apps/web has no jsdom.

function decision(
  id: string,
  decision_value: "approved" | "rejected",
  overrides: Partial<TemplateActionConfigCanonical> = {},
): TemplateActionConfigCanonical {
  return {
    id,
    label: id,
    kind: "decision",
    decision_value,
    style: "primary",
    ...overrides,
  };
}

function iteration(
  id: string,
  overrides: Partial<TemplateActionConfigCanonical> = {},
): TemplateActionConfigCanonical {
  return {
    id,
    label: id,
    kind: "iteration",
    style: "secondary",
    ...overrides,
  };
}

function sideEffect(
  id: string,
  overrides: Partial<TemplateActionConfigCanonical> = {},
): TemplateActionConfigCanonical {
  return {
    id,
    label: id,
    kind: "side_effect",
    style: "secondary",
    ...overrides,
  };
}

describe("filterEnabled", () => {
  it("includes actions with no enabled_for_status when status=pending (default behavior)", () => {
    const a = decision("approve", "approved");
    expect(filterEnabled([a], "pending")).toEqual([a]);
  });

  it("excludes actions with no enabled_for_status when status is not pending", () => {
    const a = decision("approve", "approved");
    expect(filterEnabled([a], "awaiting_iteration")).toEqual([]);
  });

  it("respects an explicit enabled_for_status list", () => {
    const a = decision("approve", "approved", {
      enabled_for_status: ["pending", "awaiting_external"] as ReviewStatus[],
    });
    expect(filterEnabled([a], "awaiting_external")).toEqual([a]);
    expect(filterEnabled([a], "awaiting_iteration")).toEqual([]);
  });

  it("returns an empty array for an empty input", () => {
    expect(filterEnabled([], "pending")).toEqual([]);
  });
});

describe("sortStable", () => {
  it("orders by ascending numeric `order` field", () => {
    const sorted = sortStable([
      decision("c", "approved", { order: 2 }),
      decision("a", "approved", { order: 0 }),
      decision("b", "approved", { order: 1 }),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  it("falls back to alphabetical id for equal orders", () => {
    const sorted = sortStable([
      decision("zebra", "approved"),
      decision("alpha", "approved"),
      decision("mango", "approved"),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["alpha", "mango", "zebra"]);
  });

  it("treats omitted order as 0 for the sort key", () => {
    const sorted = sortStable([
      decision("z", "approved", { order: 1 }),
      decision("a", "approved"),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["a", "z"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      decision("c", "approved", { order: 2 }),
      decision("a", "approved", { order: 0 }),
    ];
    const before = input.map((a) => a.id);
    sortStable(input);
    expect(input.map((a) => a.id)).toEqual(before);
  });
});

describe("sliceInlineOverflow", () => {
  it("returns everything inline when length <= INLINE_LIMIT", () => {
    const list = [
      decision("a", "approved"),
      decision("b", "rejected"),
    ];
    const out = sliceInlineOverflow(list);
    expect(out.inline).toHaveLength(2);
    expect(out.overflow).toHaveLength(0);
  });

  it("splits exactly at INLINE_LIMIT for length > INLINE_LIMIT", () => {
    const list = [
      decision("a", "approved"),
      decision("b", "rejected"),
      iteration("c"),
      iteration("d"),
      iteration("e"),
    ];
    const out = sliceInlineOverflow(list);
    expect(out.inline).toHaveLength(INLINE_LIMIT);
    expect(out.overflow.map((a) => a.id)).toEqual(["c", "d", "e"]);
  });

  it("returns empty inline + overflow on empty input", () => {
    expect(sliceInlineOverflow([])).toEqual({ inline: [], overflow: [] });
  });
});

describe("resolveVisibleActions", () => {
  it("filters by status, sorts, then slices in one call", () => {
    const list = [
      decision("approve", "approved", {
        order: 0,
        enabled_for_status: ["pending"] as ReviewStatus[],
      }),
      decision("reject", "rejected", {
        order: 1,
        enabled_for_status: ["pending"] as ReviewStatus[],
      }),
      iteration("escalate", {
        order: 2,
        enabled_for_status: ["pending"] as ReviewStatus[],
      }),
      iteration("flag", {
        order: 3,
        enabled_for_status: ["pending"] as ReviewStatus[],
      }),
      sideEffect("cancel_iteration", {
        enabled_for_status: ["awaiting_iteration"] as ReviewStatus[],
      }),
    ];
    const out = resolveVisibleActions(list, "pending");
    expect(out.inline.map((a) => a.id)).toEqual(["approve", "reject"]);
    expect(out.overflow.map((a) => a.id)).toEqual(["escalate", "flag"]);
  });
});

describe("kindToOptimisticPatch", () => {
  it("returns undefined when prev is undefined (cache not warm)", () => {
    expect(
      kindToOptimisticPatch({
        prev: undefined,
        action: decision("approve", "approved"),
        nowIso: "2026-05-08T00:00:00Z",
      }),
    ).toBeUndefined();
  });

  it("flips status to decided + sets decision + decided_at for decision-kind", () => {
    const patch = kindToOptimisticPatch({
      prev: { status: "pending" as ReviewStatus, decided_at: null },
      action: decision("approve", "approved"),
      nowIso: "2026-05-08T00:00:00Z",
    });
    expect(patch).toMatchObject({
      status: "decided",
      decision: "approved",
      decided_at: "2026-05-08T00:00:00Z",
    });
  });

  it("returns undefined for iteration-kind (server response drives status)", () => {
    expect(
      kindToOptimisticPatch({
        prev: { status: "pending" as ReviewStatus, decided_at: null },
        action: iteration("escalate"),
        nowIso: "2026-05-08T00:00:00Z",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for side_effect-kind (server response drives status)", () => {
    expect(
      kindToOptimisticPatch({
        prev: { status: "awaiting_iteration" as ReviewStatus, decided_at: null },
        action: sideEffect("cancel_iteration"),
        nowIso: "2026-05-08T00:00:00Z",
      }),
    ).toBeUndefined();
  });
});

describe("isKnownIcon", () => {
  it("returns true for whitelisted names", () => {
    expect(isKnownIcon("approve")).toBe(true);
    expect(isKnownIcon("escalate")).toBe(true);
  });

  it("returns false for unknown / undefined names (fallback to no icon)", () => {
    expect(isKnownIcon("unknown_icon")).toBe(false);
    expect(isKnownIcon(undefined)).toBe(false);
  });
});

describe("successLabelFor", () => {
  it("returns 'Approved' for decision-kind with decision_value='approved'", () => {
    expect(successLabelFor(decision("approve", "approved"))).toBe("Approved");
  });

  it("returns 'Rejected' for decision-kind with decision_value='rejected'", () => {
    expect(successLabelFor(decision("reject", "rejected"))).toBe("Rejected");
  });

  it("falls back to the canonical label for non-decision kinds", () => {
    expect(successLabelFor(iteration("escalate", { label: "Escalate" }))).toBe(
      "Escalate",
    );
    expect(
      successLabelFor(sideEffect("cancel_iteration", { label: "Cancel Iteration" })),
    ).toBe("Cancel Iteration");
  });
});

describe("withSystemDefaults", () => {
  it("returns input unchanged for non-awaiting_iteration status", () => {
    const input = [decision("approve", "approved"), decision("reject", "rejected")];
    expect(withSystemDefaults(input, "pending")).toEqual(input);
    expect(withSystemDefaults(input, "awaiting_external")).toEqual(input);
    expect(withSystemDefaults(input, "decided")).toEqual(input);
  });

  it("returns input unchanged when cancel_iteration is already authored on awaiting_iteration", () => {
    const input = [
      decision("approve", "approved"),
      sideEffect("cancel_iteration", { label: "Cancel" }),
    ];
    const result = withSystemDefaults(input, "awaiting_iteration");
    expect(result).toHaveLength(2);
    expect(result.filter((a) => a.id === "cancel_iteration")).toHaveLength(1);
  });

  it("appends cancel_iteration preset when missing on awaiting_iteration", () => {
    const input = [decision("approve", "approved"), decision("reject", "rejected")];
    const result = withSystemDefaults(input, "awaiting_iteration");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(input[0]);
    expect(result[1]).toEqual(input[1]);
    expect(result[2]).toMatchObject({
      id: "cancel_iteration",
      kind: "side_effect",
      enabled_for_status: ["awaiting_iteration"],
    });
  });

  it("returns a fresh array reference (caller can't mutate input cache)", () => {
    const input = [decision("approve", "approved")];
    const passthrough = withSystemDefaults(input, "pending");
    const noDuplicate = withSystemDefaults(
      [sideEffect("cancel_iteration", { label: "Cancel" })],
      "awaiting_iteration",
    );
    const appended = withSystemDefaults(input, "awaiting_iteration");
    expect(passthrough).not.toBe(input);
    expect(noDuplicate).not.toBe(input);
    expect(appended).not.toBe(input);
  });
});

/**
 * action-tones.test.ts — unit tests for toButtons() pure function.
 *
 * Covers: tone mapping, ordering, default approve/reject, monitoring path,
 * requires_feedback propagation, style=destructive override.
 */
import { describe, it, expect } from "vitest";
import { toButtons } from "./action-tones";
import type { Review } from "@gatewerk/web-core/api/reviews";

/** Minimal Review stub — only the fields toButtons() touches. */
function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: "r_test",
    object: "review",
    project_id: "proj_1",
    template_id: null,
    template_slug: "test",
    payload: {},
    priority: "medium",
    status: "pending",
    oversight: "blocking",
    decision: null,
    edited_payload: null,
    feedback: null,
    decided_by: null,
    decided_at: null,
    current_version: 1,
    assignee: null,
    ...overrides,
  } as Review;
}

// ---------------------------------------------------------------------------
// Default path (no template actions)
// ---------------------------------------------------------------------------

describe("default approve/reject (no template)", () => {
  it("returns Reject then Approve (neutral-first order)", () => {
    const btns = toButtons(makeReview({ template: undefined }));
    expect(btns).toHaveLength(2);
    expect(btns[0].label).toBe("Reject");
    expect(btns[0].tone).toBe("red");
    expect(btns[0].kind).toBe("default");
    expect(btns[1].label).toBe("Approve");
    expect(btns[1].tone).toBe("green");
    expect(btns[1].kind).toBe("default");
  });

  it("sets requiresFeedback=false on defaults", () => {
    const btns = toButtons(makeReview({ template: undefined }));
    expect(btns.every((b) => b.requiresFeedback === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tone mapping
// ---------------------------------------------------------------------------

const TEMPLATE_BASE = { id: "tpl_1", slug: "test-tpl" } as const;

describe("tone mapping from canonical actions", () => {
  it("decision+approved → green", () => {
    const review = makeReview({
      template: {
        ...TEMPLATE_BASE,
        name: "T",
        fields: [],
        actions: [
          { id: "a1", label: "Approve", kind: "decision", decision_value: "approved" },
        ],
      },
    });
    const btns = toButtons(review);
    expect(btns.find((b) => b.id === "a1")?.tone).toBe("green");
  });

  it("decision+rejected → red", () => {
    const review = makeReview({
      template: {
        ...TEMPLATE_BASE,
        name: "T",
        fields: [],
        actions: [
          { id: "a2", label: "Reject", kind: "decision", decision_value: "rejected" },
        ],
      },
    });
    const btns = toButtons(review);
    expect(btns.find((b) => b.id === "a2")?.tone).toBe("red");
  });

  it("style=destructive → red (overrides kind)", () => {
    const review = makeReview({
      template: {
        ...TEMPLATE_BASE,
        name: "T",
        fields: [],
        actions: [
          { id: "a3", label: "Cancel", kind: "iteration", style: "destructive" },
        ],
      },
    });
    const btns = toButtons(review);
    expect(btns.find((b) => b.id === "a3")?.tone).toBe("red");
  });

  it("side_effect without style → neutral", () => {
    const review = makeReview({
      template: {
        ...TEMPLATE_BASE,
        name: "T",
        fields: [],
        actions: [
          { id: "a4", label: "Escalate", kind: "side_effect" },
        ],
      },
    });
    const btns = toButtons(review);
    expect(btns.find((b) => b.id === "a4")?.tone).toBe("neutral");
  });
});

// ---------------------------------------------------------------------------
// Ordering: neutral → red → green
// ---------------------------------------------------------------------------

describe("ordering", () => {
  it("sorts neutral → red → green (primary last)", () => {
    const review = makeReview({
      template: {
        ...TEMPLATE_BASE,
        name: "T",
        fields: [],
        actions: [
          { id: "g", label: "Approve", kind: "decision", decision_value: "approved" },
          { id: "n", label: "Escalate", kind: "side_effect" },
          { id: "r", label: "Reject", kind: "decision", decision_value: "rejected" },
        ],
      },
    });
    const btns = toButtons(review);
    const tones = btns.map((b) => b.tone);
    expect(tones).toEqual(["neutral", "red", "green"]);
  });
});

// ---------------------------------------------------------------------------
// requires_feedback propagation
// ---------------------------------------------------------------------------

describe("requires_feedback propagation", () => {
  it("propagates true from canonical action", () => {
    const review = makeReview({
      template: {
        ...TEMPLATE_BASE,
        name: "T",
        fields: [],
        actions: [
          { id: "rc", label: "Request Changes", kind: "iteration", requires_feedback: true },
        ],
      },
    });
    const btns = toButtons(review);
    expect(btns.find((b) => b.id === "rc")?.requiresFeedback).toBe(true);
  });

  it("defaults to false when not set", () => {
    const review = makeReview({
      template: {
        ...TEMPLATE_BASE,
        name: "T",
        fields: [],
        actions: [
          { id: "a", label: "Approve", kind: "decision", decision_value: "approved" },
        ],
      },
    });
    const btns = toButtons(review);
    expect(btns[0].requiresFeedback).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Monitoring path
// ---------------------------------------------------------------------------

describe("monitoring path", () => {
  it("returns Veto (red) then Confirm (green) for monitoring reviews", () => {
    const review = makeReview({
      oversight: "monitoring",
      status: "monitoring",
      template: undefined,
    });
    const btns = toButtons(review);
    expect(btns).toHaveLength(2);
    expect(btns[0].label).toBe("Veto");
    expect(btns[0].tone).toBe("red");
    expect(btns[0].kind).toBe("monitoring");
    expect(btns[1].label).toBe("Confirm");
    expect(btns[1].tone).toBe("green");
    expect(btns[1].kind).toBe("monitoring");
  });

  it("does NOT use monitoring path when oversight=monitoring but status!=monitoring", () => {
    const review = makeReview({
      oversight: "monitoring",
      status: "pending",
      template: undefined,
    });
    const btns = toButtons(review);
    // falls to default approve/reject
    expect(btns.some((b) => b.kind === "default")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Status-aware filtering (spec §S14 / §S14b)
// ---------------------------------------------------------------------------

describe("awaiting_iteration (enabled_for_status filtering)", () => {
  it("template-less waiting review shows Cancel Iteration only, never Approve/Reject", () => {
    const btns = toButtons(
      makeReview({ status: "awaiting_iteration", template: undefined }),
    );
    expect(btns).toHaveLength(1);
    expect(btns[0].id).toBe("cancel_iteration");
    expect(btns[0].tone).toBe("neutral");
    expect(btns.some((b) => b.label === "Approve")).toBe(false);
  });

  it("filters template actions to those enabled for awaiting_iteration", () => {
    const review = makeReview({
      status: "awaiting_iteration",
      template: {
        id: "tpl_1",
        name: "T",
        actions: [
          // pending-only by default (no enabled_for_status) — must be filtered out
          { id: "publish", label: "Publish", kind: "decision", decision_value: "approved" },
          // explicitly enabled for awaiting_iteration — must survive
          {
            id: "reject_from_iteration",
            label: "Reject",
            kind: "decision",
            decision_value: "rejected",
            enabled_for_status: ["awaiting_iteration"],
          },
        ],
      } as unknown as Review["template"],
    });
    const btns = toButtons(review);
    const ids = btns.map((b) => b.id);
    expect(ids).not.toContain("publish");
    expect(ids).toContain("reject_from_iteration");
    expect(ids).toContain("cancel_iteration");
    // neutral (cancel) before red (reject) per tone order
    expect(ids.indexOf("cancel_iteration")).toBeLessThan(ids.indexOf("reject_from_iteration"));
  });

  it("pending review keeps its pending-enabled template actions", () => {
    const review = makeReview({
      status: "pending",
      template: {
        id: "tpl_1",
        name: "T",
        actions: [
          { id: "publish", label: "Publish", kind: "decision", decision_value: "approved" },
        ],
      } as unknown as Review["template"],
    });
    const ids = toButtons(review).map((b) => b.id);
    expect(ids).toContain("publish");
    expect(ids).not.toContain("cancel_iteration");
  });
});

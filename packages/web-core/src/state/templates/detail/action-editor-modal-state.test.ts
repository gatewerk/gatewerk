import { describe, it, expect } from "vitest";
import {
  EMPTY_FORM,
  applySubmittedAction,
  buildCanonical,
  canonicalToFormState,
  demoteAction,
  extractPreserved,
  labelToActionId,
  resolveStyle,
  roleOf,
  roleOwnsDestructive,
  sanitizeActionId,
  styleForSubmit,
  validate,
  type FormState,
  type ValidateContext,
} from "./action-editor-modal-state";
import type { TemplateActionConfigCanonical } from "@gatewerk/shared";

// Pure-logic coverage for the modal's FormState <-> canonical bridge. All the
// transformations (extractPreserved, buildCanonical, validate, the demotion
// helpers) are framework-free; they reduce a working state into a wire-shape
// and report errors inline. JSX/lifecycle behavior is exercised end-to-end via
// Playwright.
//
// Rewritten for surface tiering: FormState went from nine keys to
// three (id, label, role) and the duplicate-decision_value ERROR became the
// demotion AFFORDANCE, so the cases naming the removed keys and the 422 are
// gone on purpose. Round-tripping of the removed keys now lives in
// draft-config-preservation.test.ts, which is the gate for the whole removal.

function ctx(overrides: Partial<ValidateContext> = {}): ValidateContext {
  return {
    isEdit: false,
    initialId: undefined,
    existingIds: [],
    previousRole: undefined,
    ...overrides,
  };
}

function form(overrides: Partial<FormState> = {}): FormState {
  return { ...EMPTY_FORM, ...overrides };
}

describe("roleOf", () => {
  it("maps kind and decision_value onto the four roles", () => {
    expect(roleOf({ kind: "decision", decision_value: "approved" })).toBe("approve");
    expect(roleOf({ kind: "decision", decision_value: "rejected" })).toBe("reject");
    expect(roleOf({ kind: "iteration" })).toBe("send_back");
    expect(roleOf({ kind: "side_effect" })).toBe("notify");
  });
});

describe("labelToActionId", () => {
  it("slugs with underscores and never emits a hyphen", () => {
    expect(labelToActionId("Send back to agent")).toBe("send_back_to_agent");
    expect(labelToActionId("Re-open  ticket!")).toBe("re_open_ticket");
  });

  it("trims leading and trailing separators and caps at 40", () => {
    expect(labelToActionId("  ...Approve...  ")).toBe("approve");
    expect(labelToActionId("a".repeat(60))).toHaveLength(40);
  });
});

describe("sanitizeActionId", () => {
  it("strips everything outside lowercase, digits and underscore", () => {
    expect(sanitizeActionId("Approve-Now 2")).toBe("approvenow2");
    expect(sanitizeActionId("keep_this_1")).toBe("keep_this_1");
  });
});

describe("extractPreserved", () => {
  it("drops the four form-owned keys and keeps every roadmap-tier field", () => {
    const input: TemplateActionConfigCanonical = {
      id: "approve",
      label: "Approve",
      kind: "decision",
      decision_value: "approved",
      // roadmap tier — no control renders these any more
      style: "primary",
      requires_feedback: true,
      confirmation: false,
      expose_to_recipient: true,
      webhook_event: "review.approved",
      description: "Approve the review",
      icon: "check",
      order: 3,
      enabled_for_status: ["pending"],
    };
    const out = extractPreserved(input);
    expect(out).toEqual({
      style: "primary",
      requires_feedback: true,
      confirmation: false,
      expose_to_recipient: true,
      webhook_event: "review.approved",
      description: "Approve the review",
      icon: "check",
      order: 3,
      enabled_for_status: ["pending"],
    });
  });

  it("returns {} when only required canonical fields are present", () => {
    const input: TemplateActionConfigCanonical = {
      id: "x",
      label: "X",
      kind: "side_effect",
    };
    expect(extractPreserved(input)).toEqual({});
  });
});

describe("buildCanonical", () => {
  it("returns null when no role is picked", () => {
    expect(buildCanonical(form({ role: "" }), {})).toBeNull();
  });

  it("expands each role into kind plus decision_value", () => {
    const base = { id: "a", label: "A" };
    expect(buildCanonical(form({ ...base, role: "approve" }), {})).toMatchObject({
      kind: "decision",
      decision_value: "approved",
    });
    expect(buildCanonical(form({ ...base, role: "reject" }), {})).toMatchObject({
      kind: "decision",
      decision_value: "rejected",
    });

    const sendBack = buildCanonical(form({ ...base, role: "send_back" }), {})!;
    expect(sendBack.kind).toBe("iteration");
    expect(sendBack.decision_value).toBeUndefined();

    const notify = buildCanonical(form({ ...base, role: "notify" }), {})!;
    expect(notify.kind).toBe("side_effect");
    expect(notify.decision_value).toBeUndefined();
  });

  it("drops a preserved webhook_event when the role makes it a decision", () => {
    // The schema forbids webhook_event on kind=decision, so a side-effect
    // action promoted to Approve cannot carry its old event onto the wire.
    const out = buildCanonical(
      form({ id: "a", label: "A", role: "approve" }),
      { webhook_event: "custom.event" },
    );
    expect(out!.webhook_event).toBeUndefined();
    expect(out!.decision_value).toBe("approved");
  });

  it("keeps a preserved webhook_event on non-decision roles", () => {
    const out = buildCanonical(
      form({ id: "a", label: "A", role: "notify" }),
      { webhook_event: "custom.event" },
    );
    expect(out!.webhook_event).toBe("custom.event");
  });

  it("spreads preserved as base and lets form fields win on key conflicts", () => {
    const out = buildCanonical(
      form({ id: "a", label: "Form Label", role: "approve" }),
      {
        description: "preserved-desc",
        // intentionally include a label — form should win
        label: "Preserved Label" as unknown as string,
      } as Partial<TemplateActionConfigCanonical>,
    );
    expect(out!.description).toBe("preserved-desc");
    expect(out!.label).toBe("Form Label");
  });

  it("derives style from the role when the action carries none", () => {
    expect(buildCanonical(form({ id: "a", label: "A", role: "approve" }), {})!.style).toBe("primary");
    expect(buildCanonical(form({ id: "a", label: "A", role: "reject" }), {})!.style).toBe("destructive");
    expect(buildCanonical(form({ id: "a", label: "A", role: "notify" }), {})!.style).toBeUndefined();
  });

  it("keeps an API-set style the role would not have produced", () => {
    const out = buildCanonical(
      form({ id: "a", label: "A", role: "approve" }),
      { style: "warning" },
      "approve",
    );
    expect(out!.style).toBe("warning");
  });

  it("moves the derived style when the role changes", () => {
    const out = buildCanonical(
      form({ id: "a", label: "A", role: "reject" }),
      { style: "primary" },
      "approve",
    );
    expect(out!.style).toBe("destructive");
  });
});

describe("resolveStyle", () => {
  it("derives when nothing is stored", () => {
    expect(resolveStyle(undefined, "approve", undefined)).toBe("primary");
    expect(resolveStyle(undefined, "send_back", undefined)).toBeUndefined();
  });

  it("leaves a bespoke style alone", () => {
    expect(resolveStyle("send_back", "notify", "warning")).toBe("warning");
  });
});

describe("canonicalToFormState", () => {
  it("reduces an action to id, label, role and the destructive bit", () => {
    expect(canonicalToFormState({ id: "x", label: "X", kind: "side_effect" })).toEqual({
      id: "x",
      label: "X",
      role: "notify",
      destructive: false,
    });
  });

  it("seeds the bit from a stored destructive on a role that owns it", () => {
    expect(
      canonicalToFormState({ id: "x", label: "X", kind: "side_effect", style: "destructive" })
        .destructive,
    ).toBe(true);
    expect(
      canonicalToFormState({ id: "x", label: "X", kind: "iteration", style: "destructive" })
        .destructive,
    ).toBe(true);
  });

  // A reject IS destructive, but the switch is not drawn on it. Seeding true
  // there would survive a later role change and carry red onto a role that
  // never implied it.
  it("leaves the bit false on a reject, whose style the role already fixes", () => {
    expect(
      canonicalToFormState({
        id: "r",
        label: "Reject",
        kind: "decision",
        decision_value: "rejected",
        style: "destructive",
      }).destructive,
    ).toBe(false);
  });
});

describe("roleOwnsDestructive", () => {
  it("is the operator's bit only where the role implies no colour", () => {
    expect(roleOwnsDestructive("send_back")).toBe(true);
    expect(roleOwnsDestructive("notify")).toBe(true);
    expect(roleOwnsDestructive("approve")).toBe(false);
    expect(roleOwnsDestructive("reject")).toBe(false);
    expect(roleOwnsDestructive("")).toBe(false);
  });
});

describe("styleForSubmit", () => {
  it("makes a notify destructive when the bit is on — the reason the control exists", () => {
    expect(styleForSubmit("notify", "notify", undefined, true)).toBe("destructive");
  });

  it("makes a send back destructive when the bit is on", () => {
    expect(styleForSubmit("send_back", "send_back", undefined, true)).toBe("destructive");
  });

  it("clears a destructive when the bit goes off", () => {
    expect(styleForSubmit("notify", "notify", "destructive", false)).toBeUndefined();
    expect(styleForSubmit("send_back", "send_back", "destructive", false)).toBeUndefined();
  });

  // HIDE, NEVER DELETE applies to values too: neither of these has a control,
  // so a save must not be the thing that removes them.
  it("leaves an API-set secondary or warning alone", () => {
    expect(styleForSubmit("notify", "notify", "secondary", false)).toBe("secondary");
    expect(styleForSubmit("notify", "notify", "warning", false)).toBe("warning");
    expect(styleForSubmit("send_back", "send_back", "warning", false)).toBe("warning");
  });

  it("still derives the two roles that carry their own colour", () => {
    expect(styleForSubmit(undefined, "approve", undefined, false)).toBe("primary");
    expect(styleForSubmit(undefined, "reject", undefined, false)).toBe("destructive");
  });

  // The bit is ignored on approve/reject rather than obeyed: an approve that
  // renders red is a contradiction, and the control that would set it is not
  // on screen for those roles anyway.
  it("refuses to repaint an approve even if the bit somehow says so", () => {
    expect(styleForSubmit(undefined, "approve", undefined, true)).toBe("primary");
  });

  it("re-derives across a role change, as it always did", () => {
    expect(styleForSubmit("approve", "reject", "primary", false)).toBe("destructive");
    expect(styleForSubmit("reject", "notify", "destructive", false)).toBeUndefined();
  });
});

describe("demoteAction", () => {
  it("moves a verdict to Notify without touching its roadmap-tier values", () => {
    const out = demoteAction({
      id: "approve",
      label: "Approve",
      kind: "decision",
      decision_value: "approved",
      style: "primary",
      requires_feedback: true,
      confirmation: true,
      icon: "check",
      order: 2,
      enabled_for_status: ["pending"],
      expose_to_recipient: false,
      description: "agent-facing",
    });

    expect(out.kind).toBe("side_effect");
    expect(out.decision_value).toBeUndefined();
    // the derived style goes with the role it was derived from
    expect(out.style).toBeUndefined();

    expect(out.requires_feedback).toBe(true);
    expect(out.confirmation).toBe(true);
    expect(out.icon).toBe("check");
    expect(out.order).toBe(2);
    expect(out.enabled_for_status).toEqual(["pending"]);
    expect(out.expose_to_recipient).toBe(false);
    expect(out.description).toBe("agent-facing");
  });
});

describe("applySubmittedAction", () => {
  const approve: TemplateActionConfigCanonical = {
    id: "approve",
    label: "Approve",
    kind: "decision",
    decision_value: "approved",
    style: "primary",
  };
  const reject: TemplateActionConfigCanonical = {
    id: "reject",
    label: "Reject",
    kind: "decision",
    decision_value: "rejected",
    style: "destructive",
  };

  it("appends an added action and demotes the incumbent holding that role", () => {
    const out = applySubmittedAction(
      [approve, reject],
      { id: "sign_off", label: "Sign off", kind: "decision", decision_value: "approved" },
      null,
    );
    expect(out).toHaveLength(3);
    expect(out[0].id).toBe("approve");
    expect(out[0].kind).toBe("side_effect");
    expect(out[0].decision_value).toBeUndefined();
    expect(out[1]).toEqual(reject);
    expect(out[2].decision_value).toBe("approved");
  });

  it("replaces on edit and demotes the other holder of the new role", () => {
    const out = applySubmittedAction(
      [approve, reject],
      { ...reject, decision_value: "approved", kind: "decision" },
      1,
    );
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe("side_effect");
    expect(out[1].decision_value).toBe("approved");
  });

  it("leaves the list alone when the submitted action carries no verdict", () => {
    const out = applySubmittedAction(
      [approve, reject],
      { id: "note", label: "Note", kind: "side_effect" },
      null,
    );
    expect(out[0]).toEqual(approve);
    expect(out[1]).toEqual(reject);
  });

  it("does not demote the action being edited into itself", () => {
    const out = applySubmittedAction([approve, reject], { ...approve, label: "Approve v2" }, 0);
    expect(out[0].kind).toBe("decision");
    expect(out[0].decision_value).toBe("approved");
    expect(out[0].label).toBe("Approve v2");
  });
});

describe("validate", () => {
  const happyApprove = form({ id: "approve", label: "Approve", role: "approve" });

  it("flags empty id as Required", () => {
    const result = validate(form({ ...happyApprove, id: "" }), {}, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.id).toBe("Required");
  });

  it("flags invalid id chars", () => {
    const result = validate(form({ ...happyApprove, id: "Bad-ID" }), {}, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.id).toContain("Lowercase");
  });

  it("flags empty label", () => {
    const result = validate(form({ ...happyApprove, label: "  " }), {}, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.label).toBe("Required");
  });

  it("flags an unpicked role", () => {
    const result = validate(form({ ...happyApprove, role: "" }), {}, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.role).toBe("Required");
  });

  it("flags id colliding with existingIds", () => {
    const result = validate(happyApprove, {}, ctx({ existingIds: ["approve"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.id).toBe("Action ID already in use");
  });

  it("self-excludes initialId on edit", () => {
    const result = validate(
      happyApprove,
      {},
      ctx({ isEdit: true, initialId: "approve", existingIds: ["approve"] }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a role another action already holds — the list demotes, it does not reject", () => {
    // Was an error before surface tiering. applySubmittedAction now demotes the
    // incumbent, so the modal has nothing to complain about.
    const result = validate(happyApprove, {}, ctx());
    expect(result.ok).toBe(true);
  });

  it("returns ok with canonical value preserving extra fields", () => {
    const result = validate(
      happyApprove,
      { description: "desc", enabled_for_status: ["pending"] },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("approve");
      expect(result.value.description).toBe("desc");
      expect(result.value.enabled_for_status).toEqual(["pending"]);
    }
  });
});

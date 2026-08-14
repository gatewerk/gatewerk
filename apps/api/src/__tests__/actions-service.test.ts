// Pure-function tests for the action dispatcher. No DB,
// no HTTP — invokeAction takes a snapshot and returns a Result. Mirrors
// spec §3.1 + §5 + §7 + §9 expectations.

import { describe, it, expect } from "vitest";
import type { TemplateActionConfig } from "@gatewerk/shared";
import {
  invokeAction,
  type ActionActor,
  type InvokeActionInput,
} from "../services/reviews/actions";

const APPROVE: TemplateActionConfig = {
  id: "approve",
  label: "Approve",
  kind: "decision",
  decision_value: "approved",
  style: "primary",
};

const REJECT: TemplateActionConfig = {
  id: "reject",
  label: "Reject",
  kind: "decision",
  decision_value: "rejected",
  style: "destructive",
  requires_feedback: true,
};

const REQUEST_CHANGES: TemplateActionConfig = {
  id: "request_changes",
  label: "Request Changes",
  kind: "iteration",
  webhook_event: "review.changes_requested",
  requires_feedback: true,
};

const ESCALATE_WITH_EVENT: TemplateActionConfig = {
  id: "escalate",
  label: "Escalate to Manager",
  kind: "iteration",
  webhook_event: "review.escalated",
  requires_feedback: true,
};

const ESCALATE_NO_EVENT: TemplateActionConfig = {
  id: "escalate_default",
  label: "Escalate (default event)",
  kind: "iteration",
};

const LOG_TO_COMPLIANCE: TemplateActionConfig = {
  id: "log_to_compliance",
  label: "Log to Compliance",
  kind: "side_effect",
};

const REVIEWER: ActionActor = {
  kind: "reviewer",
  id: "alice@example.com",
  email: "alice@example.com",
};

function baseInput(overrides: Partial<InvokeActionInput> = {}): InvokeActionInput {
  return {
    review: {
      id: "gw_rev_test",
      status: "pending",
      current_version: 1,
      template_actions_snapshot: [APPROVE, REJECT, REQUEST_CHANGES],
    },
    actionId: "approve",
    actor: REVIEWER,
    triggerPath: "manual",
    ...overrides,
  };
}

describe("invokeAction — happy paths", () => {
  it("decision approve → status=decided, decision=approved, dual-fires review.decided", () => {
    const result = invokeAction(baseInput({ actionId: "approve" }));
    if (!result.ok) throw new Error(`Expected ok, got ${result.code}`);

    expect(result.stateUpdate.status).toBe("decided");
    expect(result.stateUpdate.decision).toBe("approved");
    // Legacy SDK contract: decided_by is the raw identifier (email/key prefix),
    // NOT the formatted "<kind>:<id>". The formatted variant lives on
    // last_action_by where kind-prefix is required for actor disambiguation.
    expect(result.stateUpdate.decided_by).toBe("alice@example.com");
    expect(result.stateUpdate.last_action_id).toBe("approve");
    expect(result.stateUpdate.last_action_kind).toBe("decision");
    expect(result.stateUpdate.last_action_by).toBe("reviewer:alice@example.com");

    expect(result.audit.action).toBe("review.action_taken");
    expect(result.audit.resource_id).toBe("gw_rev_test");
    expect(result.audit.actor).toBe("reviewer:alice@example.com");
    expect(result.audit.details.action_id).toBe("approve");
    expect(result.audit.details.action_kind).toBe("decision");
    expect(result.audit.details.decision_value).toBe("approved");
    expect(result.audit.details.trigger_path).toBe("manual");

    const events = result.webhooks.map((w) => w.event);
    expect(events).toEqual(["review.action_taken", "review.decided"]);
  });

  it("decision reject → status=decided, decision=rejected, dual-fires review.decided", () => {
    const result = invokeAction(
      baseInput({ actionId: "reject", feedback: "Not aligned with brand voice" }),
    );
    if (!result.ok) throw new Error(`Expected ok, got ${result.code}`);

    expect(result.stateUpdate.status).toBe("decided");
    expect(result.stateUpdate.decision).toBe("rejected");

    const decided = result.webhooks.find((w) => w.event === "review.decided");
    expect(decided).toBeDefined();
    expect(decided?.payload.decision).toBe("rejected");
    expect(decided?.payload.feedback).toBe("Not aligned with brand voice");
  });

  it("iteration request_changes (legacy preset) → status=awaiting_iteration, dual-fires review.retried", () => {
    const result = invokeAction(
      baseInput({
        actionId: "request_changes",
        feedback: "Tone is too informal",
      }),
    );
    if (!result.ok) throw new Error(`Expected ok, got ${result.code}`);

    expect(result.stateUpdate.status).toBe("awaiting_iteration");
    expect(result.stateUpdate.decision).toBeUndefined();
    expect(result.stateUpdate.decided_at).toBeUndefined();
    expect(result.stateUpdate.last_action_kind).toBe("iteration");

    const events = result.webhooks.map((w) => w.event);
    expect(events).toEqual(["review.action_taken", "review.retried"]);
  });

  it("iteration custom with webhook_event → fires that named event (not review.retried)", () => {
    const result = invokeAction(
      baseInput({
        review: {
          id: "gw_rev_x",
          status: "pending",
          current_version: 1,
          template_actions_snapshot: [APPROVE, ESCALATE_WITH_EVENT],
        },
        actionId: "escalate",
        feedback: "Above $10K threshold",
      }),
    );
    if (!result.ok) throw new Error(`Expected ok, got ${result.code}`);

    expect(result.stateUpdate.status).toBe("awaiting_iteration");
    const events = result.webhooks.map((w) => w.event);
    expect(events).toEqual(["review.action_taken", "review.escalated"]);
    expect(events).not.toContain("review.retried");
  });

  it("iteration custom without webhook_event → fires review.iteration_<id>", () => {
    const result = invokeAction(
      baseInput({
        review: {
          id: "gw_rev_y",
          status: "pending",
          current_version: 1,
          template_actions_snapshot: [APPROVE, ESCALATE_NO_EVENT],
        },
        actionId: "escalate_default",
      }),
    );
    if (!result.ok) throw new Error(`Expected ok, got ${result.code}`);

    const events = result.webhooks.map((w) => w.event);
    expect(events).toEqual(["review.action_taken", "review.iteration_escalate_default"]);
  });

  it("side_effect → no status change, only review.action_taken fires", () => {
    const result = invokeAction(
      baseInput({
        review: {
          id: "gw_rev_z",
          status: "pending",
          current_version: 1,
          template_actions_snapshot: [APPROVE, LOG_TO_COMPLIANCE],
        },
        actionId: "log_to_compliance",
      }),
    );
    if (!result.ok) throw new Error(`Expected ok, got ${result.code}`);

    expect(result.stateUpdate.status).toBe("pending");
    expect(result.stateUpdate.decision).toBeUndefined();
    expect(result.stateUpdate.last_action_kind).toBe("side_effect");

    const events = result.webhooks.map((w) => w.event);
    expect(events).toEqual(["review.action_taken"]);
  });
});

describe("invokeAction — validation failures", () => {
  it("unknown action_id → action.unknown_action", () => {
    const result = invokeAction(baseInput({ actionId: "nonexistent" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("action.unknown_action");
    expect(result.field).toBe("action_id");
  });

  it("status guard: action with default enabled_for_status invoked on awaiting_iteration → action.status_not_allowed", () => {
    const result = invokeAction(
      baseInput({
        review: {
          id: "gw_rev_blocked",
          status: "awaiting_iteration",
          current_version: 2,
          template_actions_snapshot: [APPROVE, REJECT],
        },
        actionId: "approve",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("action.status_not_allowed");
  });

  it("status guard: action with explicit enabled_for_status passes when matching", () => {
    const cancelIteration: TemplateActionConfig = {
      id: "cancel_iteration",
      label: "Cancel iteration",
      kind: "side_effect",
      enabled_for_status: ["awaiting_iteration"],
    };
    const result = invokeAction(
      baseInput({
        review: {
          id: "gw_rev_can",
          status: "awaiting_iteration",
          current_version: 2,
          template_actions_snapshot: [cancelIteration],
        },
        actionId: "cancel_iteration",
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("feedback guard: action.requires_feedback=true with no feedback → action.feedback_required", () => {
    const result = invokeAction(
      baseInput({ actionId: "reject" /* requires_feedback */ }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("action.feedback_required");
    expect(result.field).toBe("feedback");
  });

  it("feedback guard: whitespace-only feedback is rejected", () => {
    const result = invokeAction(baseInput({ actionId: "reject", feedback: "   " }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("action.feedback_required");
  });

  it("optimistic lock mismatch → version_mismatch", () => {
    const result = invokeAction(
      baseInput({ actionId: "approve", expectedVersion: 5 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("version_mismatch");
  });

  it("optimistic lock match (or absent) passes", () => {
    const okMatch = invokeAction(baseInput({ actionId: "approve", expectedVersion: 1 }));
    expect(okMatch.ok).toBe(true);
    const okAbsent = invokeAction(baseInput({ actionId: "approve" }));
    expect(okAbsent.ok).toBe(true);
  });

  it("malformed snapshot: decision-kind action without decision_value → action.unknown_action", () => {
    const broken: TemplateActionConfig = {
      id: "broken_decision",
      label: "Broken Decision",
      kind: "decision",
      // decision_value intentionally missing — schema would reject this on
      // template save, but the dispatcher re-checks defensively.
    };
    const result = invokeAction(
      baseInput({
        review: {
          id: "gw_rev_b",
          status: "pending",
          current_version: 1,
          template_actions_snapshot: [broken],
        },
        actionId: "broken_decision",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("action.unknown_action");
  });
});

describe("invokeAction — webhook payload shape", () => {
  it("review.action_taken payload includes uniform fields per spec §9.1", () => {
    const result = invokeAction(
      baseInput({
        actionId: "approve",
        editedPayload: { title: "edited" },
      }),
    );
    if (!result.ok) throw new Error("expected ok");

    const taken = result.webhooks.find((w) => w.event === "review.action_taken");
    expect(taken).toBeDefined();
    const payload = taken!.payload as Record<string, unknown>;
    expect(payload.review_id).toBe("gw_rev_test");
    expect(payload.action).toMatchObject({
      id: "approve",
      kind: "decision",
      decision_value: "approved",
    });
    expect(payload.actor).toMatchObject({
      type: "reviewer",
      id: "alice@example.com",
    });
    expect(payload.trigger_path).toBe("manual");
    expect(payload.edited_payload).toEqual({ title: "edited" });
  });

  it("trigger_path 'chain' surfaces in audit + webhook", () => {
    const result = invokeAction(
      baseInput({
        actionId: "approve",
        triggerPath: "chain",
        actor: { kind: "chain", id: "step_xyz" },
      }),
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.audit.details.trigger_path).toBe("chain");
    expect(result.audit.actor).toBe("chain:step_xyz");

    const taken = result.webhooks.find((w) => w.event === "review.action_taken");
    expect((taken!.payload as { trigger_path: string }).trigger_path).toBe("chain");
  });
});

describe("invokeAction — reject_from_iteration (spec §S14b)", () => {
  it("reject_from_iteration on awaiting_iteration → decided/rejected", () => {
    const REJECT_FROM_ITERATION: TemplateActionConfig = {
      id: "reject_from_iteration",
      label: "Reject",
      kind: "decision",
      decision_value: "rejected",
      style: "destructive",
      enabled_for_status: ["awaiting_iteration"],
    };
    const result = invokeAction(baseInput({
      review: {
        id: "gw_rev_test",
        status: "awaiting_iteration",
        current_version: 1,
        template_actions_snapshot: [APPROVE, REJECT, REJECT_FROM_ITERATION],
      },
      actionId: "reject_from_iteration",
    }));
    if (!result.ok) throw new Error(`Expected ok, got ${result.code}`);
    expect(result.stateUpdate.status).toBe("decided");
    expect(result.stateUpdate.decision).toBe("rejected");
    expect(result.stateUpdate.last_action_id).toBe("reject_from_iteration");
    expect(result.stateUpdate.last_action_kind).toBe("decision");
  });
});

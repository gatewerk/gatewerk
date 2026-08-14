import { describe, it, expect, vi } from "vitest";
import { NOTIFICATION_EVENTS } from "@gatewerk/shared";
import { EventBus, type EventData } from "../services/events";

const base: EventData = {
  review_id: "gw_rev_1",
  template: "refund",
  project_id: "gw_prj_1",
  priority: "normal",
  created_at: new Date().toISOString(),
};

describe("EventBus", () => {
  it("delivers emitted events to registered handlers", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("review.created", handler);

    bus.emit("review.created", base);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(base);
  });

  it("on() returns an unsubscribe function that detaches the handler", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const unsubscribe = bus.on("review.created", handler);

    bus.emit("review.created", base);
    unsubscribe();
    bus.emit("review.created", base);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("off() detaches a specific handler without affecting others", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on("review.created", a);
    bus.on("review.created", b);

    bus.off("review.created", a);
    bus.emit("review.created", base);

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("off() is idempotent — detaching an already-detached handler is a no-op", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("review.created", handler);

    bus.off("review.created", handler);
    expect(() => bus.off("review.created", handler)).not.toThrow();
  });

  it("allows a handler to off() itself during emit without breaking the walk", () => {
    const bus = new EventBus();
    const a = vi.fn(() => bus.off("review.created", a));
    const b = vi.fn();
    bus.on("review.created", a);
    bus.on("review.created", b);

    bus.emit("review.created", base);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("propagates enriched payload fields to handlers", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("review.decided", handler);

    const enriched: EventData = {
      ...base,
      decision: "approved",
      decided_at: new Date().toISOString(),
    };
    bus.emit("review.decided", enriched);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "approved",
        decided_at: enriched.decided_at,
      }),
    );
  });

  it("registers review.assignment_escalated as a notification event", () => {
    expect(NOTIFICATION_EVENTS).toContain("review.assignment_escalated");
  });

  it("registers review.action_taken as a notification event", () => {
    expect(NOTIFICATION_EVENTS).toContain("review.action_taken");
  });

  it("registers review.sent_back as a notification event", () => {
    expect(NOTIFICATION_EVENTS).toContain("review.sent_back");
  });

  it("registers review.questions_raised as a notification event", () => {
    expect(NOTIFICATION_EVENTS).toContain("review.questions_raised");
  });

  it("AVAILABLE_EVENTS picker ⊆ NOTIFICATION_EVENTS — drift detector", () => {
    // Source of truth: apps/web/src/pages/settings/project/webhooks/_options.ts
    // Keep this list in sync with AVAILABLE_EVENTS whenever the picker changes.
    const PICKER_VALUES = [
      "review.created",
      "review.urgent",
      "review.assigned",
      "review.decided",
      "review.expired",
      "review.retried",
      "review.assignment_escalated",
      "review.action_taken",
      "review.sent_back",
      "review.questions_raised",
    ];
    for (const event of PICKER_VALUES) {
      expect(NOTIFICATION_EVENTS).toContain(event);
    }
  });

  it("delivers assignment_escalated events with ladder-specific enriched fields", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("review.assignment_escalated", handler);

    const escalation: EventData = {
      ...base,
      previous_assignee: "alice@example.com",
      new_assignee: "bob@example.com",
      ladder_index: 1,
      escalated_at: new Date().toISOString(),
    };
    bus.emit("review.assignment_escalated", escalation);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        previous_assignee: "alice@example.com",
        new_assignee: "bob@example.com",
        ladder_index: 1,
      }),
    );
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { EventBus, type EventData } from "../services/events";
import {
  subscribeAll,
  acquireConnectionSlot,
  currentConnectionCount,
  toWirePayload,
  __resetConnectionCountsForTest,
} from "../services/sse-hub";
import type { NotificationEvent } from "@gatewerk/shared";

const base: EventData = {
  review_id: "gw_rev_1",
  template: "refund",
  project_id: "gw_prj_1",
  priority: "normal",
  created_at: new Date().toISOString(),
};

describe("SSE hub — subscribeAll", () => {
  beforeEach(() => {
    __resetConnectionCountsForTest();
  });

  it("receives every NOTIFICATION_EVENT on the bus", () => {
    const bus = new EventBus();
    const received: Array<[NotificationEvent, string]> = [];
    const sub = subscribeAll(bus, "session:u1", (event, data) => {
      received.push([event, data.review_id]);
    });

    bus.emit("review.created", base);
    bus.emit("review.decided", { ...base, review_id: "gw_rev_2" });
    bus.emit("review.expired", { ...base, review_id: "gw_rev_3" });

    expect(received).toEqual([
      ["review.created", "gw_rev_1"],
      ["review.decided", "gw_rev_2"],
      ["review.expired", "gw_rev_3"],
    ]);

    sub.close();
  });

  it("close() detaches all handlers and stops delivery", () => {
    const bus = new EventBus();
    const received: NotificationEvent[] = [];
    const sub = subscribeAll(bus, "session:u2", (event) => {
      received.push(event);
    });

    bus.emit("review.created", base);
    sub.close();
    bus.emit("review.created", base);
    bus.emit("review.decided", base);

    expect(received).toEqual(["review.created"]);
  });

  it("close() is idempotent", () => {
    const bus = new EventBus();
    const sub = subscribeAll(bus, "session:u3", () => {});
    expect(() => {
      sub.close();
      sub.close();
    }).not.toThrow();
  });

  it("two subscriptions each receive events and detach independently", () => {
    const bus = new EventBus();
    const a: string[] = [];
    const b: string[] = [];
    const subA = subscribeAll(bus, "session:uA", (e) => a.push(e));
    const subB = subscribeAll(bus, "session:uB", (e) => b.push(e));

    bus.emit("review.created", base);
    subA.close();
    bus.emit("review.decided", base);

    expect(a).toEqual(["review.created"]);
    expect(b).toEqual(["review.created", "review.decided"]);

    subB.close();
    bus.emit("review.expired", base);
    expect(b).toEqual(["review.created", "review.decided"]);
  });
});

describe("SSE hub — connection slots", () => {
  beforeEach(() => {
    __resetConnectionCountsForTest();
  });

  it("acquireConnectionSlot enforces the per-user cap", () => {
    const key = "session:heavy_user";
    expect(acquireConnectionSlot(key, 3)).toBe(true);
    expect(acquireConnectionSlot(key, 3)).toBe(true);
    expect(acquireConnectionSlot(key, 3)).toBe(true);
    expect(acquireConnectionSlot(key, 3)).toBe(false);
    expect(currentConnectionCount(key)).toBe(3);
  });

  it("close() releases the slot", () => {
    const key = "session:releaser";
    const bus = new EventBus();
    acquireConnectionSlot(key, 2);
    expect(currentConnectionCount(key)).toBe(1);
    const sub = subscribeAll(bus, key, () => {});
    sub.close();
    expect(currentConnectionCount(key)).toBe(0);
  });

  it("slots are per-user", () => {
    expect(acquireConnectionSlot("session:a", 1)).toBe(true);
    expect(acquireConnectionSlot("session:b", 1)).toBe(true);
    expect(acquireConnectionSlot("session:a", 1)).toBe(false);
    expect(acquireConnectionSlot("session:b", 1)).toBe(false);
  });
});

describe("toWirePayload", () => {
  it("maps EventData to the SSE wire shape with the event type", () => {
    const wire = toWirePayload("review.created", base);
    expect(wire).toEqual({
      type: "review.created",
      review_id: "gw_rev_1",
      project_id: "gw_prj_1",
      template_slug: "refund",
      priority: "normal",
      created_at: base.created_at,
    });
  });

  it("forwards chain context fields when set on EventData", () => {
    // Chain-attached emits carry the four chain fields onto the wire so the
    // dashboard can invalidate the chain queryKey on receive. Verify all
    // four make it through.
    const wire = toWirePayload("review.created", {
      ...base,
      chain_run_id: "gw_chain_xyz",
      chain_step_id: "gw_step_abc",
      step_index: 2,
      total_steps: 3,
    });
    expect(wire.chain_run_id).toBe("gw_chain_xyz");
    expect(wire.chain_step_id).toBe("gw_step_abc");
    expect(wire.step_index).toBe(2);
    expect(wire.total_steps).toBe(3);
  });

  it("drops chain context fields when undefined on EventData", () => {
    // Non-chain reviews leave chain_run_id/chain_step_id/step_index/
    // total_steps unset. The wire payload must not include them
    // (drops them rather than serialising as `null`) so non-chain
    // wire payloads stay byte-identical to the pre-A2 shape.
    const wire = toWirePayload("review.created", base);
    expect(wire).not.toHaveProperty("chain_run_id");
    expect(wire).not.toHaveProperty("chain_step_id");
    expect(wire).not.toHaveProperty("step_index");
    expect(wire).not.toHaveProperty("total_steps");
  });
});

import { describe, it, expect } from "vitest";
import type { WebhookDelivery } from "@gatewerk/web-core/api/deliveries";
import {
  DELIVERY_ERROR_TRUNCATE,
  DELIVERY_EVENT_TYPES,
  EMPTY_DELIVERY_FILTERS,
  appendDeliveriesPage,
  buildDeliveryParams,
  canRetryDelivery,
  deliveryMeta,
  deliveryStatusParam,
  deliveryStatusTone,
  deliveryTimestamp,
  hasActiveDeliveryFilters,
  hasActiveDismissableDeliveryFilters,
  isDeliveryErrorLong,
  truncateDeliveryError,
  type DeliveryFilters,
} from "./deliveries-logic";

function fakeDeliveryFilters(overrides: Partial<DeliveryFilters> = {}): DeliveryFilters {
  return { ...EMPTY_DELIVERY_FILTERS, ...overrides };
}

function fakeDelivery(id: string, overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id,
    object: "webhook_delivery",
    review_id: "rev_1",
    event_type: "review.decided",
    url: "https://example.com/hook",
    status: "delivered",
    attempts: 1,
    max_attempts: 5,
    last_attempt_at: "2026-08-02T00:00:00Z",
    next_attempt_at: null,
    last_error: null,
    delivered_at: "2026-08-02T00:00:00Z",
    created_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("appendDeliveriesPage", () => {
  it("replaces at offset 0 (fresh load)", () => {
    expect(appendDeliveriesPage([fakeDelivery("a")], [fakeDelivery("b")], 0)).toEqual([fakeDelivery("b")]);
  });

  it("appends at a later offset (Load more)", () => {
    expect(appendDeliveriesPage([fakeDelivery("a")], [fakeDelivery("b")], 50)).toEqual([
      fakeDelivery("a"),
      fakeDelivery("b"),
    ]);
  });
});

describe("deliveryStatusTone", () => {
  it("failed", () => {
    expect(deliveryStatusTone("failed")).toBe("failed");
  });

  it("pending", () => {
    expect(deliveryStatusTone("pending")).toBe("pending");
  });

  it("delivered renders no pill", () => {
    expect(deliveryStatusTone("delivered")).toBeNull();
  });
});

describe("canRetryDelivery", () => {
  it("true only for failed", () => {
    expect(canRetryDelivery("failed")).toBe(true);
    expect(canRetryDelivery("pending")).toBe(false);
    expect(canRetryDelivery("delivered")).toBe(false);
  });
});

describe("deliveryStatusParam", () => {
  it("omits the param for the unfiltered default", () => {
    expect(deliveryStatusParam("all")).toBeUndefined();
  });

  it("passes the specific status straight through otherwise", () => {
    expect(deliveryStatusParam("failed")).toBe("failed");
    expect(deliveryStatusParam("pending")).toBe("pending");
    expect(deliveryStatusParam("delivered")).toBe("delivered");
  });
});

describe("buildDeliveryParams", () => {
  it("only sets limit/offset when no filter is active", () => {
    expect(buildDeliveryParams(EMPTY_DELIVERY_FILTERS, 0)).toEqual({ limit: 50, offset: 0 });
  });

  it("includes status, omitting it for the unfiltered default", () => {
    expect(buildDeliveryParams(fakeDeliveryFilters({ status: "failed" }), 0)).toEqual({
      status: "failed",
      limit: 50,
      offset: 0,
    });
    expect(buildDeliveryParams(fakeDeliveryFilters({ status: "all" }), 0)).toEqual({
      limit: 50,
      offset: 0,
    });
  });

  it("converts dateFrom/dateTo to local start/end-of-day instants", () => {
    const params = buildDeliveryParams(
      fakeDeliveryFilters({ dateFrom: "2026-08-01", dateTo: "2026-08-04" }),
      0,
    );
    expect(params.from).toBeDefined();
    expect(params.to).toBeDefined();
    const from = new Date(params.from!);
    const to = new Date(params.to!);
    expect([from.getDate(), from.getHours(), from.getMinutes()]).toEqual([1, 0, 0]);
    expect([to.getDate(), to.getHours(), to.getMinutes()]).toEqual([4, 23, 59]);
  });

  it("combines status and date range with the requested offset", () => {
    const params = buildDeliveryParams(
      fakeDeliveryFilters({ status: "delivered", dateFrom: "2026-08-01" }),
      50,
    );
    expect(params.status).toBe("delivered");
    expect(params.from).toBeDefined();
    expect(params.to).toBeUndefined();
    expect(params.offset).toBe(50);
  });

  it("includes event_type, omitting it when unset", () => {
    expect(
      buildDeliveryParams(fakeDeliveryFilters({ eventType: ["review.decided", "review.expired"] }), 0),
    ).toEqual({
      event_type: ["review.decided", "review.expired"],
      limit: 50,
      offset: 0,
    });
    expect(buildDeliveryParams(fakeDeliveryFilters({ eventType: [] }), 0)).toEqual({ limit: 50, offset: 0 });
  });
});

describe("DELIVERY_EVENT_TYPES", () => {
  it("is the legacy per-project delivery vocabulary, not webhooks-logic's AVAILABLE_EVENTS", () => {
    const values = DELIVERY_EVENT_TYPES.map((o) => o.value);
    // Only this table's real event_type writers (services/webhooks.ts) — not
    // the separate notification_channels vocabulary.
    expect(values).toContain("review.veto_delivery_failed");
    expect(values).toContain("review.confirmed_delivery_failed");
    expect(values).not.toContain("review.created");
  });
});

describe("hasActiveDeliveryFilters", () => {
  it("false when nothing is set", () => {
    expect(hasActiveDeliveryFilters(EMPTY_DELIVERY_FILTERS)).toBe(false);
  });

  it("true when any single filter is set", () => {
    expect(hasActiveDeliveryFilters(fakeDeliveryFilters({ status: "failed" }))).toBe(true);
    expect(hasActiveDeliveryFilters(fakeDeliveryFilters({ eventType: ["review.decided"] }))).toBe(true);
    expect(hasActiveDeliveryFilters(fakeDeliveryFilters({ dateFrom: "2026-08-01" }))).toBe(true);
    expect(hasActiveDeliveryFilters(fakeDeliveryFilters({ dateTo: "2026-08-01" }))).toBe(true);
  });
});

describe("hasActiveDismissableDeliveryFilters", () => {
  it("false when nothing is set, even with a non-default status", () => {
    expect(hasActiveDismissableDeliveryFilters(EMPTY_DELIVERY_FILTERS)).toBe(false);
    expect(hasActiveDismissableDeliveryFilters(fakeDeliveryFilters({ status: "failed" }))).toBe(false);
    expect(hasActiveDismissableDeliveryFilters(fakeDeliveryFilters({ status: "pending" }))).toBe(false);
    expect(hasActiveDismissableDeliveryFilters(fakeDeliveryFilters({ status: "delivered" }))).toBe(false);
  });

  it("true when event type is set", () => {
    expect(hasActiveDismissableDeliveryFilters(fakeDeliveryFilters({ eventType: ["review.decided"] }))).toBe(
      true,
    );
  });

  it("true when either end of the date range is set", () => {
    expect(hasActiveDismissableDeliveryFilters(fakeDeliveryFilters({ dateFrom: "2026-08-01" }))).toBe(true);
    expect(hasActiveDismissableDeliveryFilters(fakeDeliveryFilters({ dateTo: "2026-08-01" }))).toBe(true);
  });
});

describe("deliveryMeta", () => {
  it("attempt N/M", () => {
    expect(deliveryMeta({ attempts: 3, max_attempts: 5 })).toEqual(["attempt 3/5"]);
  });
});

describe("deliveryTimestamp", () => {
  it("uses last_attempt_at when present", () => {
    expect(
      deliveryTimestamp({ last_attempt_at: "2026-08-02T00:00:00Z", created_at: "2026-08-01T00:00:00Z" }),
    ).toBe("2026-08-02T00:00:00Z");
  });

  it("falls back to created_at when no attempt has been made yet", () => {
    expect(deliveryTimestamp({ last_attempt_at: null, created_at: "2026-08-01T00:00:00Z" })).toBe(
      "2026-08-01T00:00:00Z",
    );
  });
});

describe("isDeliveryErrorLong / truncateDeliveryError", () => {
  it("short error is not long", () => {
    expect(isDeliveryErrorLong("connection refused")).toBe(false);
  });

  it("error past the truncate length is long", () => {
    const long = "x".repeat(DELIVERY_ERROR_TRUNCATE + 1);
    expect(isDeliveryErrorLong(long)).toBe(true);
    expect(truncateDeliveryError(long)).toBe(`${"x".repeat(DELIVERY_ERROR_TRUNCATE)}…`);
  });
});

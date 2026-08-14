import { describe, it, expect } from "vitest";
import type { AuditEvent } from "@gatewerk/web-core/api/audit";
import {
  buildAuditParams,
  hasActiveActivityFilters,
  appendActivityPage,
  activityEventMeta,
  EMPTY_ACTIVITY_FILTERS,
  type ActivityFilters,
} from "./activity-logic";

function fakeFilters(overrides: Partial<ActivityFilters> = {}): ActivityFilters {
  return { ...EMPTY_ACTIVITY_FILTERS, ...overrides };
}

function fakeEvent(id: string): AuditEvent {
  return {
    id,
    action: "review.created",
    actor: "system",
    resource_type: "review",
    resource_id: null,
    details: null,
    created_at: "2026-08-01T00:00:00Z",
    object: "audit_event",
  };
}

describe("buildAuditParams", () => {
  it("omits action and resource_type when filters are empty", () => {
    expect(buildAuditParams(EMPTY_ACTIVITY_FILTERS, 0)).toEqual({ limit: 50, offset: 0 });
  });

  it("includes only the filters that are set", () => {
    expect(buildAuditParams(fakeFilters({ action: ["review.decided"] }), 0)).toEqual({
      action: ["review.decided"],
      limit: 50,
      offset: 0,
    });
    expect(buildAuditParams(fakeFilters({ resourceType: "review" }), 50)).toEqual({
      resource_type: "review",
      limit: 50,
      offset: 50,
    });
  });

  it("includes several selected actions together", () => {
    expect(
      buildAuditParams(fakeFilters({ action: ["review.decided", "review.updated"] }), 0),
    ).toEqual({
      action: ["review.decided", "review.updated"],
      limit: 50,
      offset: 0,
    });
  });

  it("includes both filters together, with the requested offset", () => {
    expect(
      buildAuditParams(fakeFilters({ action: ["review.decided"], resourceType: "review" }), 100),
    ).toEqual({
      action: ["review.decided"],
      resource_type: "review",
      limit: 50,
      offset: 100,
    });
  });

  it("converts a bare dateFrom to that day's local start-of-day instant", () => {
    const params = buildAuditParams(fakeFilters({ dateFrom: "2026-08-01" }), 0);
    expect(params.from).toBeDefined();
    const d = new Date(params.from!);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([
      2026, 7, 1, 0, 0,
    ]);
  });

  it("converts a bare dateTo to that day's local end-of-day instant", () => {
    const params = buildAuditParams(fakeFilters({ dateTo: "2026-08-01" }), 0);
    expect(params.to).toBeDefined();
    const d = new Date(params.to!);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([
      2026, 7, 1, 23, 59,
    ]);
  });

  it("omits from/to when the date fields are unset", () => {
    const params = buildAuditParams(EMPTY_ACTIVITY_FILTERS, 0);
    expect(params.from).toBeUndefined();
    expect(params.to).toBeUndefined();
  });
});

describe("hasActiveActivityFilters", () => {
  it("false when all filters are empty", () => {
    expect(hasActiveActivityFilters(EMPTY_ACTIVITY_FILTERS)).toBe(false);
  });

  it("true when any single filter is set", () => {
    expect(hasActiveActivityFilters(fakeFilters({ action: ["review.decided"] }))).toBe(true);
    expect(hasActiveActivityFilters(fakeFilters({ resourceType: "review" }))).toBe(true);
    expect(hasActiveActivityFilters(fakeFilters({ dateFrom: "2026-08-01" }))).toBe(true);
    expect(hasActiveActivityFilters(fakeFilters({ dateTo: "2026-08-01" }))).toBe(true);
  });
});

describe("appendActivityPage", () => {
  it("replaces at offset 0 (fresh search or Clear)", () => {
    expect(appendActivityPage([fakeEvent("a")], [fakeEvent("b")], 0)).toEqual([fakeEvent("b")]);
  });

  it("appends at a later offset (Load more)", () => {
    expect(appendActivityPage([fakeEvent("a")], [fakeEvent("b")], 50)).toEqual([
      fakeEvent("a"),
      fakeEvent("b"),
    ]);
  });
});

describe("activityEventMeta", () => {
  it("resource type only when there is no resource id", () => {
    expect(activityEventMeta({ resource_type: "review", resource_id: null })).toEqual(["review"]);
  });

  it("appends the first 8 chars of the resource id when present", () => {
    expect(activityEventMeta({ resource_type: "review", resource_id: "rev_abcdefghij" })).toEqual([
      "review",
      "rev_abcd",
    ]);
  });
});

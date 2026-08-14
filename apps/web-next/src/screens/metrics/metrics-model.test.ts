import { describe, it, expect } from "vitest";
import type { StatsResponse } from "@gatewerk/web-core/api/stats";
import { TEMPLATE_LIMIT, buildMetricsModel, percentOf } from "./metrics-model";

const empty: StatsResponse = {
  total: 0,
  by_status: {},
  by_decision: {},
  avg_review_time_ms: null,
  by_template: [],
  reviews_per_day: [],
};

const stats = (over: Partial<StatsResponse>): StatsResponse => ({ ...empty, ...over });

describe("percentOf", () => {
  it("returns 0 rather than NaN when nothing has been decided", () => {
    // 0/0 is the fresh-install state, and it is the one a self-hosted operator
    // sees first. NaN here would render as "NaN%".
    expect(percentOf(0, 0)).toBe(0);
    expect(Number.isNaN(percentOf(0, 0))).toBe(false);
  });

  it("returns 0 rather than Infinity for a positive part over a zero whole", () => {
    expect(percentOf(5, 0)).toBe(0);
    expect(Number.isFinite(percentOf(5, 0))).toBe(true);
  });

  it("treats a negative denominator as empty", () => {
    expect(percentOf(3, -1)).toBe(0);
  });

  it("computes an ordinary ratio", () => {
    expect(percentOf(1, 4)).toBe(25);
    expect(percentOf(3, 3)).toBe(100);
  });
});

describe("buildMetricsModel", () => {
  it("survives a completely empty install", () => {
    const m = buildMetricsModel(empty);
    expect(m.total).toBe(0);
    expect(m.decided).toBe(0);
    expect(m.approvalPercent).toBe(0);
    expect(m.retryPercent).toBe(0);
    expect(m.slices).toEqual([]);
    expect(m.templates).toEqual([]);
  });

  it("reads missing status and decision keys as zero, not undefined", () => {
    const m = buildMetricsModel(stats({ total: 3, by_status: { pending: 3 } }));
    expect(m.pending).toBe(3);
    expect(m.decided).toBe(0);
    expect(m.approved).toBe(0);
  });

  it("computes approval and retry rates against decided, not total", () => {
    const m = buildMetricsModel(
      stats({
        total: 100, // 90 of these are still pending and must not dilute the rate
        by_status: { decided: 10, pending: 90 },
        by_decision: { approved: 5, retried: 2, rejected: 3 },
      }),
    );
    expect(m.approvalPercent).toBe(50);
    expect(m.retryPercent).toBe(20);
  });

  it("drops zero-count slices but keeps the fixed order of the rest", () => {
    const m = buildMetricsModel(
      stats({
        by_status: { decided: 6 },
        by_decision: { approved: 3, rejected: 0, edited: 1, retried: 2 },
      }),
    );
    expect(m.slices.map((s) => s.key)).toEqual(["approved", "edited", "retried"]);
  });

  it("gives slice widths that sum to 100 percent of decided", () => {
    const m = buildMetricsModel(
      stats({ by_status: { decided: 4 }, by_decision: { approved: 1, rejected: 1, edited: 1, retried: 1 } }),
    );
    expect(m.slices.reduce((sum, s) => sum + s.percent, 0)).toBeCloseTo(100);
  });

  it("sorts templates by count before applying the limit", () => {
    // The busiest template arrives last from the API here. Slicing before
    // sorting would drop it and keep eight quieter ones.
    const by_template = [
      ...Array.from({ length: TEMPLATE_LIMIT }, (_, i) => ({ template_slug: `quiet-${i}`, count: 1 })),
      { template_slug: "busiest", count: 99 },
    ];
    const m = buildMetricsModel(stats({ by_template }));
    expect(m.templates).toHaveLength(TEMPLATE_LIMIT);
    expect(m.templates[0]).toEqual({ slug: "busiest", count: 99, percent: 100 });
  });

  it("scales template bars against the busiest one", () => {
    const m = buildMetricsModel(
      stats({ by_template: [{ template_slug: "a", count: 10 }, { template_slug: "b", count: 5 }] }),
    );
    expect(m.templates[0].percent).toBe(100);
    expect(m.templates[1].percent).toBe(50);
  });

  it("does not divide by zero when every template has a count of zero", () => {
    const m = buildMetricsModel(stats({ by_template: [{ template_slug: "a", count: 0 }] }));
    expect(m.templates[0].percent).toBe(0);
  });
});

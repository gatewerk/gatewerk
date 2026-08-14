/**
 * Metrics derivations, as pure functions.
 *
 * Every number on the Metrics screen is a ratio of two counts that can both be
 * zero on a fresh install, which is exactly the state a self-hosted operator
 * sees first. Keeping the arithmetic out of the component is what makes the
 * empty case testable.
 */

import type { StatsResponse } from "@gatewerk/web-core/api/stats";

export interface DecisionSlice {
  key: "approved" | "rejected" | "edited" | "retried";
  label: string;
  count: number;
  /** Width as a percentage of all decided reviews. */
  percent: number;
}

export interface MetricsModel {
  total: number;
  pending: number;
  decided: number;
  approved: number;
  retried: number;
  /** Whole percent, floored to 0 when nothing has been decided yet. */
  approvalPercent: number;
  retryPercent: number;
  /** Only the non-zero slices, in a fixed order, ready to render. */
  slices: DecisionSlice[];
  templates: Array<{ slug: string; count: number; percent: number }>;
}

const SLICE_ORDER = [
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "edited", label: "Edited" },
  { key: "retried", label: "Retried" },
] as const;

/** Guarded ratio. A denominator of 0 yields 0, never NaN or Infinity. */
export function percentOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return (part / whole) * 100;
}

/** How many template rows the screen shows. The rest are not rendered. */
export const TEMPLATE_LIMIT = 8;

export function buildMetricsModel(data: StatsResponse): MetricsModel {
  const decided = data.by_status["decided"] ?? 0;
  const pending = data.by_status["pending"] ?? 0;

  const counts = {
    approved: data.by_decision["approved"] ?? 0,
    rejected: data.by_decision["rejected"] ?? 0,
    edited: data.by_decision["edited"] ?? 0,
    retried: data.by_decision["retried"] ?? 0,
  };

  const slices = SLICE_ORDER.map(({ key, label }) => ({
    key,
    label,
    count: counts[key],
    percent: percentOf(counts[key], decided),
  })).filter((s) => s.count > 0);

  // Sort before slicing, so the limit keeps the busiest templates rather than
  // whichever ones the API happened to return first.
  const sorted = [...data.by_template].sort((a, b) => b.count - a.count);
  const max = sorted[0]?.count ?? 0;
  const templates = sorted.slice(0, TEMPLATE_LIMIT).map((t) => ({
    slug: t.template_slug,
    count: t.count,
    percent: percentOf(t.count, max),
  }));

  return {
    total: data.total,
    pending,
    decided,
    approved: counts.approved,
    retried: counts.retried,
    approvalPercent: Math.round(percentOf(counts.approved, decided)),
    retryPercent: Math.round(percentOf(counts.retried, decided)),
    slices,
    templates,
  };
}

/** A retry rate worth drawing attention to. Matches apps/web's threshold. */
export const RETRY_WARN_PERCENT = 10;

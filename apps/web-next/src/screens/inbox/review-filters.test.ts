import { describe, it, expect } from "vitest";
import { filterByTab, tabCounts, searchReviews } from "./review-filters";
import type { Review } from "@gatewerk/web-core/api/reviews";

// Minimal Review-shaped fixtures
function make(overrides: Partial<{
  id: string;
  priority: string;
  status: string;
  template_slug: string;
  template: { name: string };
  payload: Record<string, unknown>;
}>): Review {
  return {
    id: "rev_test",
    priority: "normal",
    status: "pending",
    template_slug: "deploy-review",
    template: { id: "tpl_1", slug: "deploy-review", name: "Deploy Review" },
    payload: { title: "Test review" },
    oversight: "blocking",
    decision: null,
    created_at: new Date().toISOString(),
    assignee: null,
    held_by: null,
    chain_step_number: null,
    chain_total_steps: null,
    current_version: 1,
    expires_at: null,
    snoozed_until: null,
    ...overrides,
  } as unknown as Review;
}

const pending_normal = make({ id: "r1", status: "pending", priority: "normal" });
const pending_high = make({ id: "r2", status: "pending", priority: "high" });
const pending_critical = make({ id: "r3", status: "pending", priority: "critical" });
const pending_low = make({ id: "r4", status: "pending", priority: "low" });
const awaiting_iter = make({ id: "r5", status: "awaiting_iteration", priority: "normal" });
const awaiting_ext = make({ id: "r6", status: "awaiting_external", priority: "high" });
const decided = make({ id: "r7", status: "decided", priority: "normal" });
const archived = make({ id: "r8", status: "archived", priority: "normal" });
const monitoring = make({ id: "r9", status: "monitoring", priority: "normal" });

const ALL = [
  pending_normal, pending_high, pending_critical, pending_low,
  awaiting_iter, awaiting_ext, decided, archived, monitoring,
];

describe("filterByTab", () => {
  it("all: open reviews only — excludes archived AND decided (spec §1)", () => {
    const result = filterByTab(ALL, "all");
    expect(result.map((r) => r.id)).not.toContain("r8"); // archived
    expect(result.map((r) => r.id)).not.toContain("r7"); // decided → History
    expect(result.length).toBe(7);
  });

  it("urgent: high + critical + pending only", () => {
    const result = filterByTab(ALL, "urgent");
    const ids = result.map((r) => r.id);
    expect(ids).toContain("r2");
    expect(ids).toContain("r3");
    expect(ids).not.toContain("r1"); // normal
    expect(ids).not.toContain("r4"); // low
    expect(ids).not.toContain("r5"); // awaiting_iteration
    expect(result.length).toBe(2);
  });

  it("routine: low + normal + pending only", () => {
    const result = filterByTab(ALL, "routine");
    const ids = result.map((r) => r.id);
    expect(ids).toContain("r1");
    expect(ids).toContain("r4");
    expect(ids).not.toContain("r2"); // high
    expect(ids).not.toContain("r3"); // critical
    expect(result.length).toBe(2);
  });

  it("waiting: awaiting_iteration + awaiting_external", () => {
    const result = filterByTab(ALL, "waiting");
    const ids = result.map((r) => r.id);
    expect(ids).toContain("r5");
    expect(ids).toContain("r6");
    expect(result.length).toBe(2);
  });
});

describe("tabCounts", () => {
  it("returns correct counts for each tab", () => {
    const counts = tabCounts(ALL);
    expect(counts.all).toBe(7);    // excludes archived + decided (spec §1)
    expect(counts.urgent).toBe(2); // high + critical pending
    expect(counts.routine).toBe(2); // low + normal pending
    expect(counts.waiting).toBe(2); // awaiting_*
  });
});

describe("searchReviews", () => {
  const titleOf = (r: Review) =>
    (r.payload as Record<string, unknown>).title as string ?? r.id;

  it("matches by title (case insensitive)", () => {
    const items = [
      make({ id: "r1", payload: { title: "Deploy frontend" }, template_slug: "deploy-check" }),
      make({ id: "r2", payload: { title: "Security audit" }, template_slug: "sec-audit" }),
    ];
    // "deploy" matches r1 title AND r1 slug but NOT r2 title or slug
    const result = searchReviews(items, "security", titleOf);
    expect(result.map((r) => r.id)).toEqual(["r2"]);
  });

  it("matches by template_slug", () => {
    const items = [
      make({ id: "r1", template_slug: "deploy-check" }),
      make({ id: "r2", template_slug: "code-review" }),
    ];
    const result = searchReviews(items, "code", titleOf);
    expect(result.map((r) => r.id)).toEqual(["r2"]);
  });

  it("matches by template name", () => {
    const items = [
      make({ id: "r1", template: { name: "Deploy Check" } }),
      make({ id: "r2", template: { name: "Code Review" } }),
    ];
    const result = searchReviews(items, "code review", titleOf);
    expect(result.map((r) => r.id)).toEqual(["r2"]);
  });

  it("returns all items when query is empty", () => {
    const items = [make({ id: "r1" }), make({ id: "r2" })];
    expect(searchReviews(items, "", titleOf)).toHaveLength(2);
    expect(searchReviews(items, "  ", titleOf)).toHaveLength(2);
  });

  it("returns empty array when nothing matches", () => {
    const items = [make({ id: "r1", payload: { title: "Deploy" }, template_slug: "deploy" })];
    expect(searchReviews(items, "xyzzy", titleOf)).toHaveLength(0);
  });
});

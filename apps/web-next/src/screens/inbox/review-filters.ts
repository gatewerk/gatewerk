import type { Review } from "@gatewerk/web-core/api/reviews";

export type Tab = "all" | "urgent" | "routine" | "waiting";

/**
 * Filter reviews by the active tab.
 *
 * - all: every OPEN item — decided/archived never appear in the inbox
 *   (spec §1: decided reviews belong in History)
 * - urgent: priority high|critical AND status === "pending"
 * - routine: priority low|normal AND status === "pending"
 * - waiting: status in awaiting_iteration|awaiting_external
 */
export function filterByTab(items: Review[], tab: Tab): Review[] {
  switch (tab) {
    case "all":
      return items.filter(
        (r) => r.status !== "archived" && r.status !== "decided",
      );
    case "urgent":
      return items.filter(
        (r) =>
          (r.priority === "high" || r.priority === "critical") &&
          r.status === "pending",
      );
    case "routine":
      return items.filter(
        (r) =>
          (r.priority === "low" || r.priority === "normal") &&
          r.status === "pending",
      );
    case "waiting":
      return items.filter(
        (r) =>
          r.status === "awaiting_iteration" || r.status === "awaiting_external",
      );
  }
}

export interface TabCounts {
  all: number;
  urgent: number;
  routine: number;
  waiting: number;
}

/** Count filtered lengths for all four tabs. */
export function tabCounts(items: Review[]): TabCounts {
  return {
    all: filterByTab(items, "all").length,
    urgent: filterByTab(items, "urgent").length,
    routine: filterByTab(items, "routine").length,
    waiting: filterByTab(items, "waiting").length,
  };
}

/**
 * Case-insensitive substring search over derived title, template_slug, and
 * template.name.  Empty/whitespace query returns items unchanged.
 */
export function searchReviews(
  items: Review[],
  query: string,
  titleOf: (r: Review) => string,
): Review[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((r) => {
    const title = titleOf(r).toLowerCase();
    const slug = (r.template_slug ?? "").toLowerCase();
    const name = (r.template?.name ?? "").toLowerCase();
    return title.includes(q) || slug.includes(q) || name.includes(q);
  });
}

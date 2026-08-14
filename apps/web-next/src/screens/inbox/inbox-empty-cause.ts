/**
 * Why the inbox list is empty, and therefore what to say about it.
 *
 * An empty state has exactly one job and it differs per cause: Tier 1 explains
 * a system that has not started, Tier 2 is a dead end the reviewer built and so
 * the only useful content is the way back out. Naming the wrong cause hands
 * them the wrong door.
 *
 * Pure and exported so it can be tested — the decision this replaced lived
 * inline in ReviewList and had no test, which is how it came to treat every
 * filter as a search.
 */

import type { Tab } from "./review-filters";

export type InboxEmptyInput = {
  /** Rows surviving tab + filters + search. */
  visibleCount: number;
  tab: Tab;
  hasQuery: boolean;
  templateFilterActive: boolean;
  dateFilterActive: boolean;
};

export type InboxEmptyCause =
  | { kind: "none" }
  /** Nothing narrowing, nothing in the queue: the Tier-1 listening state. */
  | { kind: "all-clear" }
  | { kind: "tab"; tab: Exclude<Tab, "all"> }
  | { kind: "search" }
  | { kind: "template" }
  | { kind: "date" }
  | { kind: "combined" };

export function decideInboxEmptyCause(input: InboxEmptyInput): InboxEmptyCause {
  const { visibleCount, tab, hasQuery, templateFilterActive, dateFilterActive } = input;

  if (visibleCount > 0) return { kind: "none" };

  // Narrowing dimensions outrank the tab. A tab is where the reviewer lives; a
  // query or a filter is what they just did, and it is the one click that undoes
  // this. Offer the reversible thing.
  const active = [hasQuery, templateFilterActive, dateFilterActive].filter(Boolean).length;
  if (active > 1) return { kind: "combined" };
  if (hasQuery) return { kind: "search" };
  if (templateFilterActive) return { kind: "template" };
  if (dateFilterActive) return { kind: "date" };

  // Nothing narrowing. On a tab, the tab is the reason; on "all" there is no
  // narrower view to widen, so the queue itself is empty.
  return tab === "all" ? { kind: "all-clear" } : { kind: "tab", tab };
}

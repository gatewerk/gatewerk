/**
 * History list model — filtering, search, and the date grouping the redesign
 * adds.
 *
 * Design: ListHistory.dc.html. Rows are
 * grouped under TODAY / THIS WEEK / EARLIER ruler ticks, newest first within
 * each group.
 *
 * `now` is a parameter everywhere a boundary is computed. Day boundaries are
 * the classic source of off-by-one bugs here, and a function that reads the
 * clock itself cannot be tested against midnight.
 */

import { DATE_PRESETS } from "@gatewerk/web-core/lib/filter-dates";
import type { Review } from "@gatewerk/web-core/api/reviews";

export type Filter = "all" | "approved" | "rejected" | "retried";

export const FILTER_ITEMS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "retried", label: "Retried" },
];

/**
 * The three colour roles a decision maps to. Green is affirmative only, which
 * is why selection is neutral everywhere else in the UI.
 *
 * `edited` reads as approved (the action was taken, with changes) and `expired`
 * reads as retried (nobody decided; it lapsed). Both are deliberate per the
 * design README, and neither is a filter tab.
 */
export type DecisionRole = "affirmative" | "destructive" | "neutral";

export function decisionRole(decision: string | null): DecisionRole {
  switch (decision) {
    case "approved":
    case "edited":
    case "confirmed":
      return "affirmative";
    case "rejected":
    case "vetoed":
      return "destructive";
    default:
      // retried, expired, max_iterations_reached and anything the API adds
      // later. An unknown decision must not be silently coloured as approved.
      return "neutral";
  }
}

/**
 * Filter by decision tab.
 *
 * `edited` is intentionally not a tab and appears only under All, per the
 * design README. It is NOT folded into "approved": a reviewer filtering for
 * approvals is asking which requests went through untouched.
 */
export function filterByDecision(items: Review[], filter: Filter): Review[] {
  if (filter === "all") return items;
  return items.filter((r) => r.decision === filter);
}

/** Case-insensitive substring search over title, who decided, template and feedback. */
export function searchHistory(
  items: Review[],
  query: string,
  titleOf: (r: Review) => string,
): Review[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((r) => {
    const haystack = [
      titleOf(r),
      r.decided_by ?? "",
      r.template_slug ?? "",
      r.feedback ?? "",
    ]
      // The joiner is NUL so a query cannot match across a field boundary (a
      // title ending "re" next to a template starting "view" must not match
      // "review"). Written as an escape sequence deliberately: a literal 0x00
      // byte in the source makes git treat the whole file as binary.
      .join("\u0000")
      .toLowerCase();
    return haystack.includes(q);
  });
}

/** When a review was resolved. Falls back to created_at, per the design README. */
export function resolvedAt(r: Review): string {
  return r.decided_at ?? r.created_at;
}

/**
 * A record nobody decided: it lapsed, whether or not it was later archived.
 *
 * Keyed on the data, never on `status`. The server archives from both "decided"
 * and "expired" (services/reviews/lifecycle.ts) and the expire path never
 * writes `decision`/`decided_at`/`decided_by`, so a `status === "expired"` test
 * silently stops holding the moment someone archives a lapsed review — and the
 * record then claims it was "decided" by "System".
 *
 * One exported predicate rather than two inline guards: this concept was
 * expressed twice, differently, in HistoryDetail and ActivityTimeline, which is
 * exactly how the two drifted apart.
 */
export function isUndecided(r: Review): boolean {
  return r.decision === null && r.decided_at === null;
}

export type BucketKey = "today" | "week" | "earlier";

export interface Bucket {
  key: BucketKey;
  label: string;
  items: Review[];
}

const BUCKET_LABEL: Record<BucketKey, string> = {
  today: "TODAY",
  week: "THIS WEEK",
  earlier: "EARLIER",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which bucket a timestamp falls in.
 *
 * "today" is the same calendar day as `now` in local time, not "within 24
 * hours" — something decided at 23:50 yesterday is not today, even though it
 * is ten minutes ago. "this week" is the following 7 days back from the start
 * of today. A timestamp in the future is treated as today rather than being
 * dropped: clock skew between the API and the browser should not make a row
 * disappear.
 */
export function bucketOf(timestamp: string, now: Date): BucketKey {
  const t = new Date(timestamp);
  if (Number.isNaN(t.getTime())) return "earlier";

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ts = t.getTime();

  if (ts >= startOfToday) return "today";
  if (ts >= startOfToday - 7 * DAY_MS) return "week";
  return "earlier";
}

/**
 * Partition into the three buckets, newest first within each, dropping any
 * bucket that ends up empty so the list never renders a header over nothing.
 */
export function bucketByDate(items: Review[], now: Date): Bucket[] {
  const sorted = [...items].sort(
    (a, b) => new Date(resolvedAt(b)).getTime() - new Date(resolvedAt(a)).getTime(),
  );

  const groups: Record<BucketKey, Review[]> = { today: [], week: [], earlier: [] };
  for (const r of sorted) groups[bucketOf(resolvedAt(r), now)].push(r);

  return (["today", "week", "earlier"] as const)
    .filter((k) => groups[k].length > 0)
    .map((k) => ({ key: k, label: BUCKET_LABEL[k], items: groups[k] }));
}

/** The whole list pipeline, in the order the screen applies it. */
export function buildHistoryList(
  items: Review[],
  opts: { filter: Filter; query: string; now: Date; titleOf: (r: Review) => string },
): Bucket[] {
  const filtered = filterByDecision(items, opts.filter);
  const searched = searchHistory(filtered, opts.query, opts.titleOf);
  return bucketByDate(searched, opts.now);
}

function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Date filter for the popover. Calendar-day anchored — NOT the inbox's rolling
 * window — because a row sitting under the TODAY section header must match the
 * "Today" chip; mixing a rolling filter with calendar bucketing makes the two
 * disagree for late-evening rows. Measures resolvedAt: History is about when
 * the decision happened.
 */
export function matchesHistoryDate(
  r: Review,
  preset: string | null,
  from: string,
  to: string,
  now: Date,
): boolean {
  if (!preset && !from && !to) return true;
  const t = new Date(resolvedAt(r));
  if (Number.isNaN(t.getTime())) return false;
  if (preset) {
    // Spans come from the same DATE_PRESETS the chips are rendered from, so a
    // preset added in web-core cannot ship a chip this filter does not know.
    // An unknown key degrades to "no filter": a chip nobody taught this
    // function about must not silently empty the list.
    const days = DATE_PRESETS.find((p) => p.key === preset)?.days;
    if (days == null) return true;
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return t.getTime() >= startOfToday - (days - 1) * DAY_MS;
  }
  const iso = localIso(t);
  if (from && to) return iso >= from && iso <= to;
  if (from) return iso >= from;
  return iso <= to;
}

/** ↑/↓ selection step over the flattened visible list. Pure so it is testable. */
export function stepSelection(
  visibleIds: string[],
  currentId: string | null,
  dir: 1 | -1,
): string | null {
  if (visibleIds.length === 0) return null;
  const idx = currentId === null ? -1 : visibleIds.indexOf(currentId);
  if (idx === -1) return dir === 1 ? visibleIds[0] : visibleIds[visibleIds.length - 1];
  return visibleIds[Math.min(Math.max(idx + dir, 0), visibleIds.length - 1)];
}

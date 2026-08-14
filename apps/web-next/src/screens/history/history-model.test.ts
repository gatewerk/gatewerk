import { describe, it, expect } from "vitest";
import type { Review } from "@gatewerk/web-core/api/reviews";
import {
  bucketByDate,
  bucketOf,
  buildHistoryList,
  decisionRole,
  filterByDecision,
  isUndecided,
  matchesHistoryDate,
  searchHistory,
  stepSelection,
} from "./history-model";

// A fixed "now" so date-bucket tests (TODAY / THIS WEEK / EARLIER) are deterministic.
const NOW = new Date(2026, 7, 5, 10, 0, 0);

const review = (over: Partial<Review>): Review =>
  ({
    id: "rev_1",
    project_id: "proj_1",
    template_id: null,
    template_slug: "content-publish",
    payload: {},
    priority: "normal",
    status: "decided",
    decision: "approved",
    edited_payload: null,
    feedback: null,
    decided_by: "jane@example.com",
    decided_at: NOW.toISOString(),
    created_at: NOW.toISOString(),
    current_version: 1,
    ...over,
  }) as Review;

const titleOf = (r: Review) => (r.payload as { title?: string })?.title ?? r.id;

describe("decisionRole", () => {
  it("reads edited as affirmative, because the action was taken", () => {
    expect(decisionRole("edited")).toBe("affirmative");
  });

  it("reads expired as neutral, not as an approval", () => {
    // Nobody decided an expired review. Colouring it green would claim someone
    // signed off on something that simply lapsed.
    expect(decisionRole("expired")).toBe("neutral");
  });

  it("reads a veto as destructive", () => {
    expect(decisionRole("vetoed")).toBe("destructive");
  });

  it("defaults an unknown or null decision to neutral, never affirmative", () => {
    expect(decisionRole("some_future_decision")).toBe("neutral");
    expect(decisionRole(null)).toBe("neutral");
  });
});

describe("isUndecided", () => {
  const lapsed = { decision: null, decided_at: null, decided_by: null };

  it("an expired review is undecided", () => {
    expect(isUndecided(review({ status: "expired", ...lapsed }))).toBe(true);
  });

  it("archiving a lapsed review does not turn it into a decision", () => {
    // The server archives from both "decided" and "expired" and leaves the
    // decision columns alone, so status is not the thing to key on.
    expect(isUndecided(review({ status: "archived", ...lapsed }))).toBe(true);
  });

  it("a decided review is decided", () => {
    expect(isUndecided(review({ status: "decided", decision: "approved" }))).toBe(false);
  });

  it("an edited review is decided", () => {
    expect(isUndecided(review({ status: "decided", decision: "edited" }))).toBe(false);
  });
});

describe("filterByDecision", () => {
  const items = [
    review({ id: "a", decision: "approved" }),
    review({ id: "b", decision: "rejected" }),
    review({ id: "c", decision: "edited" }),
    review({ id: "d", decision: "retried" }),
  ];

  it("returns everything under All, including edited", () => {
    expect(filterByDecision(items, "all")).toHaveLength(4);
  });

  it("does not fold edited into approved", () => {
    // Filtering for approvals asks which requests went through untouched.
    const approved = filterByDecision(items, "approved");
    expect(approved.map((r) => r.id)).toEqual(["a"]);
  });

  it("filters rejected and retried", () => {
    expect(filterByDecision(items, "rejected").map((r) => r.id)).toEqual(["b"]);
    expect(filterByDecision(items, "retried").map((r) => r.id)).toEqual(["d"]);
  });
});

describe("searchHistory", () => {
  const items = [
    review({ id: "a", decided_by: "jane@example.com", template_slug: "deploy" }),
    review({ id: "b", decided_by: "sam@example.com", feedback: "looked wrong to me" }),
  ];

  it("returns everything for an empty or whitespace query", () => {
    expect(searchHistory(items, "", titleOf)).toHaveLength(2);
    expect(searchHistory(items, "   ", titleOf)).toHaveLength(2);
  });

  it("matches who decided", () => {
    expect(searchHistory(items, "jane", titleOf).map((r) => r.id)).toEqual(["a"]);
  });

  it("matches feedback text", () => {
    expect(searchHistory(items, "looked wrong", titleOf).map((r) => r.id)).toEqual(["b"]);
  });

  it("is case insensitive", () => {
    expect(searchHistory(items, "DEPLOY", titleOf).map((r) => r.id)).toEqual(["a"]);
  });

  it("tolerates null feedback and decided_by without throwing", () => {
    const sparse = [review({ id: "c", decided_by: null, feedback: null })];
    expect(() => searchHistory(sparse, "anything", titleOf)).not.toThrow();
    expect(searchHistory(sparse, "anything", titleOf)).toEqual([]);
  });
});

describe("bucketOf", () => {
  it("puts this morning in today", () => {
    expect(bucketOf(new Date(2026, 7, 5, 9, 0).toISOString(), NOW)).toBe("today");
  });

  it("puts 23:50 yesterday in this week, not today", () => {
    // Ten minutes before midnight is ten minutes ago, and still not "today".
    // A 24-hour window would get this wrong.
    expect(bucketOf(new Date(2026, 7, 4, 23, 50).toISOString(), NOW)).toBe("week");
  });

  it("puts 00:01 today in today", () => {
    expect(bucketOf(new Date(2026, 7, 5, 0, 1).toISOString(), NOW)).toBe("today");
  });

  it("puts 7 days back in this week and 8 days back in earlier", () => {
    expect(bucketOf(new Date(2026, 6, 29, 12, 0).toISOString(), NOW)).toBe("week");
    expect(bucketOf(new Date(2026, 6, 28, 9, 0).toISOString(), NOW)).toBe("earlier");
  });

  it("treats a future timestamp as today rather than dropping the row", () => {
    // Clock skew between API and browser must not make a row vanish.
    expect(bucketOf(new Date(2026, 7, 6, 12, 0).toISOString(), NOW)).toBe("today");
  });

  it("puts an unparseable timestamp in earlier instead of throwing", () => {
    expect(bucketOf("not a date", NOW)).toBe("earlier");
  });
});

describe("bucketByDate", () => {
  it("omits empty buckets so no header renders over nothing", () => {
    const items = [review({ id: "a", decided_at: new Date(2026, 7, 5, 9).toISOString() })];
    const buckets = bucketByDate(items, NOW);
    expect(buckets.map((b) => b.key)).toEqual(["today"]);
  });

  it("keeps buckets in fixed order and sorts newest first within each", () => {
    const items = [
      review({ id: "old", decided_at: new Date(2026, 6, 1, 9).toISOString() }),
      review({ id: "today-early", decided_at: new Date(2026, 7, 5, 8).toISOString() }),
      review({ id: "week", decided_at: new Date(2026, 7, 2, 9).toISOString() }),
      review({ id: "today-late", decided_at: new Date(2026, 7, 5, 9, 30).toISOString() }),
    ];
    const buckets = bucketByDate(items, NOW);
    expect(buckets.map((b) => b.key)).toEqual(["today", "week", "earlier"]);
    expect(buckets[0].items.map((r) => r.id)).toEqual(["today-late", "today-early"]);
  });

  it("falls back to created_at when decided_at is null", () => {
    const items = [
      review({ id: "a", decided_at: null, created_at: new Date(2026, 7, 5, 9).toISOString() }),
    ];
    expect(bucketByDate(items, NOW)[0].key).toBe("today");
  });

  it("does not mutate the array it is given", () => {
    const items = [
      review({ id: "a", decided_at: new Date(2026, 6, 1).toISOString() }),
      review({ id: "b", decided_at: new Date(2026, 7, 5, 9).toISOString() }),
    ];
    const order = items.map((r) => r.id);
    bucketByDate(items, NOW);
    expect(items.map((r) => r.id)).toEqual(order);
  });

  it("returns no buckets at all for an empty list", () => {
    expect(bucketByDate([], NOW)).toEqual([]);
  });
});

describe("buildHistoryList", () => {
  it("filters, then searches, then groups", () => {
    const items = [
      review({ id: "a", decision: "approved", decided_by: "jane@example.com" }),
      review({ id: "b", decision: "rejected", decided_by: "jane@example.com" }),
      review({
        id: "c",
        decision: "approved",
        decided_by: "sam@example.com",
        decided_at: new Date(2026, 6, 1).toISOString(),
      }),
    ];
    const buckets = buildHistoryList(items, {
      filter: "approved",
      query: "jane",
      now: NOW,
      titleOf,
    });
    expect(buckets).toHaveLength(1);
    expect(buckets[0].items.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("matchesHistoryDate", () => {
  const now = new Date(2026, 7, 1, 12, 0); // Aug 1 2026 local noon
  const base = review({});
  const at = (d: Date) => ({ ...base, decided_at: d.toISOString() }) as Review;
  const yesterday2350 = new Date(2026, 6, 31, 23, 50);
  const today0005 = new Date(2026, 7, 1, 0, 5);

  it("no filter passes everything", () =>
    expect(matchesHistoryDate(at(yesterday2350), null, "", "", now)).toBe(true));
  it("'today' is the calendar day, not a rolling 24h", () => {
    expect(matchesHistoryDate(at(today0005), "today", "", "", now)).toBe(true);
    expect(matchesHistoryDate(at(yesterday2350), "today", "", "", now)).toBe(false);
  });
  it("preset agrees with bucketOf: TODAY-bucketed rows always match 'today'", () => {
    for (const d of [today0005, new Date(2026, 7, 1, 11, 59)]) {
      expect(bucketOf(d.toISOString(), now)).toBe("today");
      expect(matchesHistoryDate(at(d), "today", "", "", now)).toBe(true);
    }
  });
  it("'7d' spans today plus 6 prior days, boundary inclusive", () => {
    expect(matchesHistoryDate(at(new Date(2026, 6, 26, 0, 0)), "7d", "", "", now)).toBe(true);
    expect(matchesHistoryDate(at(new Date(2026, 6, 25, 23, 59)), "7d", "", "", now)).toBe(false);
  });
  it("measures resolvedAt (decided_at ?? created_at), not created_at", () => {
    const r = { ...base, created_at: new Date(2026, 5, 1).toISOString(), decided_at: today0005.toISOString() } as Review;
    expect(matchesHistoryDate(r, "today", "", "", now)).toBe(true);
  });
  it("custom range is inclusive on both local-date endpoints", () => {
    expect(matchesHistoryDate(at(today0005), null, "2026-08-01", "2026-08-01", now)).toBe(true);
    expect(matchesHistoryDate(at(yesterday2350), null, "2026-08-01", "2026-08-05", now)).toBe(false);
  });
  it("preset wins when both preset and range are set", () =>
    expect(matchesHistoryDate(at(today0005), "today", "2020-01-01", "2020-01-02", now)).toBe(true));
  it("an unknown preset key passes everything rather than emptying the list", () => {
    // A preset added to web-core's DATE_PRESETS but not to this filter used to
    // compute a zero-day span, which matches only future timestamps.
    expect(matchesHistoryDate(at(yesterday2350), "90d", "", "", now)).toBe(true);
    expect(matchesHistoryDate(at(new Date(2019, 0, 1)), "90d", "", "", now)).toBe(true);
  });
});

describe("stepSelection", () => {
  it("steps down and clamps", () => {
    expect(stepSelection(["a", "b", "c"], "a", 1)).toBe("b");
    expect(stepSelection(["a", "b", "c"], "c", 1)).toBe("c");
  });
  it("steps up and clamps", () => {
    expect(stepSelection(["a", "b", "c"], "b", -1)).toBe("a");
    expect(stepSelection(["a", "b", "c"], "a", -1)).toBe("a");
  });
  it("null current: down selects first, up selects last", () => {
    expect(stepSelection(["a", "b"], null, 1)).toBe("a");
    expect(stepSelection(["a", "b"], null, -1)).toBe("b");
  });
  it("vanished current behaves like null (row filtered away mid-keypress)", () => {
    expect(stepSelection(["a", "b"], "zz", 1)).toBe("a");
    expect(stepSelection(["a", "b"], "zz", -1)).toBe("b");
  });
  it("empty list is null", () => expect(stepSelection([], null, 1)).toBeNull());
});

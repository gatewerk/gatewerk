/**
 * What this pins, and why it is not a copy edit:
 *
 * web-next conflated search with filter. `isSearchMiss = showEmpty &&
 * (query.trim() || filterActive)` meant a template or date filter that matched
 * nothing rendered the SEARCH empty state ("No reviews match" / "Clear search")
 * and its reset cleared both the query and every filter. The reviewer was told
 * the wrong thing about why their list was empty, and offered the wrong way out.
 *
 * The empty-state board wants four distinct causes with four distinct ways back.
 * Two or more dimensions active at once is its own cause — naming just one of
 * them would send the reviewer to clear a filter that is not the whole reason.
 */

import { describe, expect, it } from "vitest";
import { decideInboxEmptyCause, type InboxEmptyInput } from "./inbox-empty-cause";

const base: InboxEmptyInput = {
  visibleCount: 0,
  tab: "all",
  hasQuery: false,
  templateFilterActive: false,
  dateFilterActive: false,
};

describe("decideInboxEmptyCause", () => {
  it("returns none while the list has rows to show", () => {
    expect(decideInboxEmptyCause({ ...base, visibleCount: 3 })).toEqual({ kind: "none" });
  });

  it("is all-clear when nothing is narrowing and the reviewer is on the all tab", () => {
    expect(decideInboxEmptyCause(base)).toEqual({ kind: "all-clear" });
  });

  it("names the tab when a tab is the only thing excluding rows", () => {
    expect(decideInboxEmptyCause({ ...base, tab: "waiting" })).toEqual({
      kind: "tab",
      tab: "waiting",
    });
  });

  it("names search when the query is the only active dimension", () => {
    expect(decideInboxEmptyCause({ ...base, hasQuery: true })).toEqual({ kind: "search" });
  });

  it("names the template filter on its own", () => {
    expect(decideInboxEmptyCause({ ...base, templateFilterActive: true })).toEqual({
      kind: "template",
    });
  });

  it("names the date filter on its own", () => {
    expect(decideInboxEmptyCause({ ...base, dateFilterActive: true })).toEqual({ kind: "date" });
  });

  it("falls back to combined once more than one dimension is active", () => {
    expect(
      decideInboxEmptyCause({ ...base, templateFilterActive: true, dateFilterActive: true }),
    ).toEqual({ kind: "combined" });
    expect(decideInboxEmptyCause({ ...base, hasQuery: true, dateFilterActive: true })).toEqual({
      kind: "combined",
    });
    expect(
      decideInboxEmptyCause({ ...base, hasQuery: true, templateFilterActive: true }),
    ).toEqual({ kind: "combined" });
  });

  it("lets a narrowing dimension outrank the tab, because that is the reversible one", () => {
    // Tab plus filter: the filter is the thing the reviewer just did and the
    // thing one click undoes, so it is the honest way back.
    expect(decideInboxEmptyCause({ ...base, tab: "urgent", hasQuery: true })).toEqual({
      kind: "search",
    });
    expect(
      decideInboxEmptyCause({ ...base, tab: "urgent", templateFilterActive: true }),
    ).toEqual({ kind: "template" });
  });

  it("never returns tab for the all tab, which has nothing to reset to", () => {
    // ReviewList's old render guard hid exactly this case behind
    // `isTier2 && tab !== "all"` and rendered a blank column. With filters as
    // first-class causes, "all tab, filter active, nothing matched" is now the
    // common case, so it must resolve to something that renders.
    for (const extra of [
      { hasQuery: true },
      { templateFilterActive: true },
      { dateFilterActive: true },
      { hasQuery: true, dateFilterActive: true },
      {},
    ]) {
      expect(decideInboxEmptyCause({ ...base, tab: "all", ...extra }).kind).not.toBe("tab");
    }
  });

  it("covers every input combination without falling through", () => {
    const tabs = ["all", "urgent", "routine", "waiting"] as const;
    const flags = [false, true];
    for (const tab of tabs) {
      for (const hasQuery of flags) {
        for (const templateFilterActive of flags) {
          for (const dateFilterActive of flags) {
            const cause = decideInboxEmptyCause({
              visibleCount: 0,
              tab,
              hasQuery,
              templateFilterActive,
              dateFilterActive,
            });
            expect(cause.kind).not.toBe("none");
          }
        }
      }
    }
  });
});

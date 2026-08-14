/**
 * ReviewList — two-row header toolbar (spec §1b) + scrolling rows + empty states.
 *
 * Row A: tab pill (flex:1) + Filter funnel button (popover) + Collapse-list
 *        button (panel icon — the ONLY collapse control).
 * Row B: search input (inset style, magnifier icon, "/" keycap hint).
 * No select-mode checkbox in the header and no floating seam handle (spec §1b);
 * select mode is entered from the overflow/bulk affordance.
 */
import { useMemo, useRef, useState } from "react";
import type { Review } from "@gatewerk/web-core/api/reviews";
import { getReviewTitle } from "@gatewerk/web-core/lib/utils";
import { SkeletonRows } from "~/components/skeleton";
import { filterByTab, searchReviews, tabCounts, type Tab } from "./review-filters";
import {
  DATE_PRESETS,
  buildCalCells,
  currentMonth,
  fmtMonthLabel,
  matchesDate,
  shiftMonth,
} from "@gatewerk/web-core/lib/filter-dates";
import { SegmentedTabs } from "~/components/SegmentedTabs";
import { ListSearchField } from "~/components/ListSearchField";
import { IconButton } from "~/components/buttons";
import { useSlashFocus } from "~/components/use-slash-focus";
import { ReviewRow } from "./ReviewRow";
import { InboxEmpty } from "./InboxEmpty";
import { InboxFirstRun } from "./InboxFirstRun";
import { decideInboxEmptyCause } from "./inbox-empty-cause";

type Props = {
  items: Review[];
  /** Reviews are still loading. Suppresses every empty state — see below. */
  isLoading?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  tab: Tab;
  onTab: (tab: Tab) => void;
  query: string;
  onQuery: (q: string) => void;
  /** Collapse the list column (Row-A panel button — the only collapse control). */
  onCollapse: () => void;
  /**
   * Hide the collapse button. On a phone there is no collapsed strip to
   * collapse into (Inbox renders the list full width or not at all), so the
   * button would be an affordance for a behaviour the reader cannot have.
   * Defaults to false so every desktop call site is unaffected.
   */
  hideCollapse?: boolean;
  /** Whether bulk select mode is active */
  selectMode: boolean;
  /** Set of checked review ids */
  checkedIds: Set<string>;
  /** Toggle a single row's checked state */
  onToggleRow: (id: string) => void;
  /** Set of review_ids with at least one unread notification. */
  unreadIds?: Set<string>;
};

function templateSlugOf(r: Review): string {
  return r.template_slug ?? r.template?.name ?? "";
}

const TABS = [
  { value: "all", label: "All" },
  { value: "urgent", label: "Urgent" },
  { value: "routine", label: "Routine" },
  { value: "waiting", label: "Waiting" },
] as const satisfies readonly { value: Tab; label: string }[];

export function ReviewList({
  items,
  isLoading = false,
  selectedId,
  onSelect,
  tab,
  onTab,
  query,
  onQuery,
  onCollapse,
  hideCollapse = false,
  selectMode,
  checkedIds,
  onToggleRow,
  unreadIds,
}: Props) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [templateFilter, setTemplateFilter] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  const [datePreset, setDatePreset] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [calMonth, setCalMonth] = useState(currentMonth);
  const [calOpen, setCalOpen] = useState(false);

  const templateOptions = useMemo(
    () => [...new Set(items.map(templateSlugOf).filter(Boolean))],
    [items],
  );

  function toggleTemplate(name: string) {
    setTemplateFilter((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  }

  function pickDay(iso: string) {
    if (!dateFrom || (dateFrom && dateTo)) {
      setDateFrom(iso); setDateTo(""); setDatePreset(null);
    } else if (iso < dateFrom) {
      setDateTo(dateFrom); setDateFrom(iso); setDatePreset(null);
    } else {
      setDateTo(iso); setDatePreset(null);
    }
  }

  function clearFilter() {
    setTemplateFilter([]);
    setDatePreset(null);
    setDateFrom("");
    setDateTo("");
  }

  // Tracked separately, not as one `filterActive` boolean: the empty state has
  // to name which filter emptied the list, and offer to reset that one.
  const templateFilterActive = templateFilter.length > 0;
  const dateFilterActive = !!datePreset || !!dateFrom || !!dateTo;
  const filterActive = templateFilterActive || dateFilterActive;
  const calOpenEffective = calOpen || !!dateFrom || !!dateTo;
  const calCells = buildCalCells(calMonth, dateFrom, dateTo);
  const rangeLabel =
    dateFrom && dateTo
      ? `${dateFrom}  →  ${dateTo}`
      : dateFrom
        ? `${dateFrom}  →  pick end`
        : "Pick a start date";

  const counts = tabCounts(items);
  const filtered = filterByTab(items, tab)
    .filter((r) => templateFilter.length === 0 || templateFilter.includes(templateSlugOf(r)))
    .filter((r) => matchesDate(r, datePreset, dateFrom, dateTo));
  const titleOf = (r: Review) => getReviewTitle(r.payload, r.id);
  const visible = searchReviews(filtered, query, titleOf);

  // Which empty state, and why. The decision is a tested pure function because
  // the inline version it replaced quietly told reviewers their search had
  // failed when it was their template filter.
  //
  // An empty list mid-fetch is not an empty list, which is why loading
  // short-circuits it: otherwise the first-run state mounts on every load and
  // flashes "Inbox is clear" at someone who has reviews.
  const emptyCause = isLoading
    ? ({ kind: "none" } as const)
    : decideInboxEmptyCause({
        visibleCount: visible.length,
        tab,
        hasQuery: query.trim().length > 0,
        templateFilterActive,
        dateFilterActive,
      });
  const showEmpty = emptyCause.kind !== "none";

  // Counts behind the Tier-2 hints. Each answers "your data is still there" for
  // the specific thing that hid it, so each is measured against that dimension
  // rather than reusing one total.
  const otherTemplateCount = useMemo(
    () =>
      templateFilterActive
        ? filterByTab(items, tab).filter(
            (r) => !templateFilter.includes(templateSlugOf(r)),
          ).length
        : 0,
    [items, tab, templateFilter, templateFilterActive],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex flex-col gap-[11px] px-3 pb-[11px] pt-[15px]">
        {/* Tab row */}
        <div className="flex items-center gap-2">
          <SegmentedTabs tabs={TABS} active={tab} onChange={onTab} ariaLabel="Filter by state" />

          {/* Filter (funnel) — 30×30, green dot when active, opens filter popover */}
          <div className="relative shrink-0">
            <IconButton
              title="Filter"
              onClick={() => setFilterOpen((o) => !o)}
              active={filterOpen || templateFilter.length > 0}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              {filterActive && (
                <span
                  style={{
                    position: "absolute",
                    top: 5,
                    right: 5,
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--gw-green)",
                  }}
                />
              )}
            </IconButton>

            {filterOpen && (
              <>
                <div
                  className="fixed inset-0 z-[39]"
                  onClick={() => setFilterOpen(false)}
                />
                <div
                  className="absolute right-0 z-[40]"
                  style={{
                    top: 38,
                    width: 236,
                    background: "rgba(var(--gw-glass-rgb),.74)",
                    backdropFilter: "blur(18px) saturate(140%)",
                    WebkitBackdropFilter: "blur(18px) saturate(140%)",
                    border: "1px solid rgba(var(--gw-line-rgb),.14)",
                    borderRadius: 11,
                    boxShadow:
                      "0 18px 44px rgba(0,0,0,.5), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
                    padding: 8,
                    maxHeight: 440,
                    overflowY: "auto",
                  }}
                >
                  <div
                    className="flex items-center gap-2"
                    style={{ padding: "4px 8px 8px" }}
                  >
                    <span
                      className="font-mono text-[9px] font-semibold uppercase"
                      style={{ letterSpacing: ".14em", color: "var(--gw-t8)" }}
                    >
                      Template
                    </span>
                    <span className="flex-1" />
                    {/* Always rendered, not conditionally mounted — see
                        HistoryListHeader.tsx's identical popover for why:
                        a mounted/unmounted "Clear all" made the popover
                        jump a few px on every toggle, since its 11px line
                        is taller than the label's 9px one. */}
                    <button
                      type="button"
                      className="cursor-pointer border-none bg-transparent p-0 text-[11px] font-medium transition-colors"
                      style={{
                        color: "var(--gw-blue-t)",
                        visibility: filterActive ? "visible" : "hidden",
                      }}
                      onClick={clearFilter}
                      tabIndex={filterActive ? 0 : -1}
                      aria-hidden={!filterActive}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.color = "var(--gw-blue-h)")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.color = "var(--gw-blue-t)")
                      }
                    >
                      Clear all
                    </button>
                  </div>
                  <div className="flex flex-col gap-[1px]">
                    {templateOptions.map((name) => {
                      const on = templateFilter.includes(name);
                      return (
                        <button
                          key={name}
                          type="button"
                          onClick={() => toggleTemplate(name)}
                          className="flex w-full cursor-pointer items-center gap-[9px] rounded-[7px] border-none bg-transparent text-left transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)]"
                          style={{ padding: "7px 8px" }}
                        >
                          <span
                            className="flex items-center justify-center"
                            style={{
                              width: 17,
                              height: 17,
                              borderRadius: 5,
                              flexShrink: 0,
                              border: on
                                ? "1.5px solid var(--gw-t3)"
                                : "1.5px solid rgba(var(--gw-line-rgb),.24)",
                              background: on ? "var(--gw-t3)" : "transparent",
                            }}
                          >
                            {on && (
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="var(--gw-green-ink)"
                                strokeWidth="3.2"
                              >
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </span>
                          <span
                            className="min-w-0 flex-1 truncate font-mono text-[11.5px]"
                            style={{ color: "var(--gw-t4)" }}
                          >
                            {name}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Divider */}
                  <div
                    style={{
                      height: 1,
                      background: "rgba(var(--gw-line-rgb),.08)",
                      margin: "8px 8px",
                    }}
                  />

                  {/* Date range presets */}
                  <div style={{ padding: "0 8px 8px" }}>
                    <span
                      className="font-mono text-[9px] font-semibold uppercase"
                      style={{ letterSpacing: ".14em", color: "var(--gw-t8)" }}
                    >
                      Date range
                    </span>
                  </div>
                  <div className="flex flex-wrap" style={{ gap: 6, padding: "0 8px" }}>
                    {DATE_PRESETS.map((p) => {
                      const on = datePreset === p.key;
                      return (
                        <button
                          key={p.key}
                          type="button"
                          onClick={() => {
                            setDatePreset(on ? null : p.key);
                            setDateFrom("");
                            setDateTo("");
                          }}
                          className="cursor-pointer transition-colors"
                          style={{
                            fontSize: 11.5,
                            fontWeight: 500,
                            padding: "5px 10px",
                            borderRadius: 7,
                            border: on
                              ? "1px solid rgba(var(--gw-line-rgb),.28)"
                              : "1px solid rgba(var(--gw-line-rgb),.12)",
                            color: on ? "var(--gw-t2)" : "var(--gw-t5)",
                            background: on ? "rgba(var(--gw-line-rgb),.1)" : "transparent",
                            fontFamily: "inherit",
                          }}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>

                  {/* Custom range toggle */}
                  <button
                    type="button"
                    onClick={() => setCalOpen((o) => !o)}
                    className="flex w-full cursor-pointer items-center border-none bg-transparent text-left"
                    style={{ gap: 8, margin: "8px 8px 0", padding: "6px 0", width: "calc(100% - 16px)" }}
                  >
                    <span className="flex-1 text-[12px]" style={{ color: "var(--gw-t5)" }}>
                      Custom range
                    </span>
                    <span
                      className="inline-flex"
                      style={{
                        transition: "transform .15s ease",
                        transform: calOpenEffective ? "rotate(180deg)" : "rotate(0deg)",
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--gw-t8)" strokeWidth="2">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </span>
                  </button>

                  {/* Calendar */}
                  {calOpenEffective && (
                    <div style={{ padding: "6px 8px 4px" }}>
                      <div className="flex items-center" style={{ gap: 8, marginBottom: 10 }}>
                        <button
                          type="button"
                          onClick={() => setCalMonth((m) => shiftMonth(m, -1))}
                          className="flex cursor-pointer items-center justify-center border-none bg-transparent text-t6 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.07)] hover:text-t3"
                          style={{ width: 24, height: 24, borderRadius: 7 }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="15 18 9 12 15 6" />
                          </svg>
                        </button>
                        <span
                          className="flex-1 text-center font-mono text-[11.5px] font-medium"
                          style={{ color: "var(--gw-t3)" }}
                        >
                          {fmtMonthLabel(calMonth)}
                        </span>
                        <button
                          type="button"
                          onClick={() => setCalMonth((m) => shiftMonth(m, 1))}
                          className="flex cursor-pointer items-center justify-center border-none bg-transparent text-t6 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.07)] hover:text-t3"
                          style={{ width: 24, height: 24, borderRadius: 7 }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        </button>
                      </div>
                      <div
                        className="grid"
                        style={{ gridTemplateColumns: "repeat(7,1fr)", gap: 2, marginBottom: 4 }}
                      >
                        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                          <span
                            key={i}
                            className="text-center font-mono text-[9px] font-medium"
                            style={{ letterSpacing: ".04em", color: "var(--gw-t10)", padding: "2px 0" }}
                          >
                            {d}
                          </span>
                        ))}
                      </div>
                      <div className="grid" style={{ gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
                        {calCells.map((cell, i) =>
                          cell.blank ? (
                            <div key={i} style={{ height: 26 }} />
                          ) : (
                            <button
                              key={i}
                              type="button"
                              onClick={() => cell.iso && pickDay(cell.iso)}
                              className="flex cursor-pointer items-center justify-center border-none font-mono text-[11px]"
                              style={{
                                height: 26,
                                borderRadius: 6,
                                color: cell.endpoint
                                  ? "var(--gw-green-ink)"
                                  : cell.inRange
                                    ? "var(--gw-t3)"
                                    : "var(--gw-t5)",
                                background: cell.endpoint
                                  ? "var(--gw-t3)"
                                  : cell.inRange
                                    ? "rgba(var(--gw-line-rgb),.1)"
                                    : "transparent",
                                fontWeight: cell.endpoint ? 600 : 400,
                              }}
                            >
                              {cell.label}
                            </button>
                          ),
                        )}
                      </div>
                      <div
                        className="flex items-center"
                        style={{
                          gap: 8,
                          marginTop: 9,
                          paddingTop: 9,
                          borderTop: "1px solid rgba(var(--gw-line-rgb),.07)",
                        }}
                      >
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-[10.5px]"
                          style={{ color: "var(--gw-t6)" }}
                        >
                          {rangeLabel}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Collapse list — panel icon, the ONLY collapse control (spec §1b) */}
          {!hideCollapse && (
            <IconButton title="Collapse list" onClick={onCollapse}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <rect
                  x="3"
                  y="4"
                  width="6.5"
                  height="16"
                  rx="2"
                  fill="currentColor"
                  stroke="none"
                />
              </svg>
            </IconButton>
          )}
        </div>

        {/* Search input. The keycap hint was decorative for weeks — the shared
            field plus useSlashFocus finally makes it true here. */}
        <ListSearchField
          value={query}
          onChange={onQuery}
          placeholder="Search reviews…"
          ariaLabel="Search reviews"
          inputRef={searchRef}
        />
      </div>

      {/* Scrollable rows */}
      <div className="flex flex-1 flex-col gap-[2px] overflow-y-auto px-1.5 pb-3">
        {isLoading && (
          <>
            <span className="sr-only" role="status">
              Loading reviews
            </span>
            <SkeletonRows count={8} rowHeight={72} />
          </>
        )}

        {!isLoading &&
          !showEmpty &&
          visible.map((review) => (
            <ReviewRow
              key={review.id}
              review={review}
              isSelected={!selectMode && selectedId === review.id}
              onClick={() => {
                if (selectMode) {
                  onToggleRow(review.id);
                } else {
                  onSelect(review.id);
                }
              }}
              selectMode={selectMode}
              isChecked={checkedIds.has(review.id)}
              unread={unreadIds?.has(review.id) ?? false}
            />
          ))}

        {/* Empty states. There is no `tab !== "all"` guard any more: with
            filters as first-class causes, "all tab, filter active, nothing
            matched" went from unreachable to common, and the old guard rendered
            a blank column for it. */}
        {!isLoading && emptyCause.kind === "all-clear" && <InboxFirstRun />}

        {!isLoading && emptyCause.kind !== "none" && emptyCause.kind !== "all-clear" && (
          <InboxEmpty
            cause={emptyCause}
            query={query}
            queueCount={counts.all}
            urgentCount={counts.urgent}
            otherTemplateCount={otherTemplateCount}
            onShowAllTabs={() => onTab("all")}
            onClearSearch={() => onQuery("")}
            onResetTemplate={() => setTemplateFilter([])}
            onResetDate={() => {
              setDatePreset(null);
              setDateFrom("");
              setDateTo("");
            }}
            onClearAllFilters={() => {
              onQuery("");
              clearFilter();
            }}
          />
        )}
      </div>
    </div>
  );
}

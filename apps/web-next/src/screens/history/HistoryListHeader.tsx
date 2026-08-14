/**
 * HistoryListHeader — the list column's header block: segmented decision tabs,
 * the funnel trigger and its filter popover, and the search field.
 *
 * Design: ListHistory.dc.html.
 *
 * Three deliberate divergences from the prototype, each recorded in the plan's
 * Deviations section:
 *   1. Live apply. The prototype draws an Apply button and two dead From/To
 *      text boxes; the inbox's popover applies on change and
 *      picks dates on a calendar. Interaction language is app-wide, so the
 *      inbox wins over one screen's mock.
 *   2. Popover chrome is the inbox's frosted glass (r11) rather than the
 *      prototype's flat #1e201d card. Floating layers are one language.
 *   3. The funnel carries the inbox's green active-filter dot. Without it a
 *      closed popover hides the fact that rows are being withheld.
 *
 * This header is the Inbox list header's design —
 * tab pill stretching, funnel, then the collapse button (ReviewList.tsx:487),
 * no divider between them because the Inbox has none. That overrides the
 * History prototype's fixed 262px tab block and its funnel/collapse divider.
 */

import { useEffect, useState, type RefObject } from "react";
import {
  DATE_PRESETS,
  buildCalCells,
  currentMonth,
  fmtMonthLabel,
  shiftMonth,
} from "@gatewerk/web-core/lib/filter-dates";
import { SegmentedTabs } from "~/components/SegmentedTabs";
import { ListSearchField } from "~/components/ListSearchField";
import { IconButton } from "~/components/buttons";
import { FILTER_ITEMS, type Filter } from "./history-model";

interface Props {
  filter: Filter;
  onFilter: (f: Filter) => void;
  query: string;
  onQuery: (q: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  filterOpen: boolean;
  onFilterOpenChange: (open: boolean) => void;
  showArchived: boolean;
  onShowArchived: (v: boolean) => void;
  templateFilter: string[];
  onToggleTemplate: (name: string) => void;
  templateOptions: string[];
  datePreset: string | null;
  onDatePreset: (key: string | null) => void;
  dateFrom: string;
  dateTo: string;
  onPickDay: (iso: string) => void;
  onClearFilters: () => void;
  filterActive: boolean;
  /** Collapse the list column to the 54px strip (the only collapse control). */
  onCollapse: () => void;
}

export function HistoryListHeader({
  filter,
  onFilter,
  query,
  onQuery,
  searchRef,
  filterOpen,
  onFilterOpenChange,
  showArchived,
  onShowArchived,
  templateFilter,
  onToggleTemplate,
  templateOptions,
  datePreset,
  onDatePreset,
  dateFrom,
  dateTo,
  onPickDay,
  onClearFilters,
  filterActive,
  onCollapse,
}: Props) {
  const [calMonth, setCalMonth] = useState(currentMonth);
  const [calOpen, setCalOpen] = useState(false);

  // Escape closes the popover. The scrim catches pointers, but a keyboard user
  // who opened the popover has no pointer to click with.
  //
  // At CAPTURE, and it calls preventDefault: that is how this app orders the
  // Escape cascade (SelectMenu in screens/templates/_ui.tsx does the same, and
  // useZen bails on `defaultPrevented`). A bubble-phase listener would lose the
  // race — useZen binds on `document`, so one Escape would close this popover
  // and drop the whole shell out of zen mode at once. `filterOpen` now lives in
  // History.tsx (use-history-keys.ts needs it to suppress ↑/↓ and to reach the
  // same conclusion in its own Escape branch), and this listener stays the one
  // that normally closes the popover. That hook is now also on document at
  // capture, so which of the two runs first is registration order — both close
  // the popover and nothing else, so either order is correct.
  useEffect(() => {
    if (!filterOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      onFilterOpenChange(false);
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [filterOpen, onFilterOpenChange]);

  const calOpenEffective = calOpen || !!dateFrom || !!dateTo;
  const calCells = buildCalCells(calMonth, dateFrom, dateTo);
  const rangeLabel =
    dateFrom && dateTo
      ? `${dateFrom}  →  ${dateTo}`
      : dateFrom
        ? `${dateFrom}  →  pick end`
        : "Pick a start date";

  return (
    <div className="flex flex-col gap-[11px] px-3 pb-[11px] pt-[15px]">
      {/* ── Tabs + trigger row ── */}
      <div className="flex items-center gap-2">
        {/* `edited` is deliberately absent from the tabs: edited reviews
            appear under All and carry their own treatment in the record. */}
        <SegmentedTabs tabs={FILTER_ITEMS} active={filter} onChange={onFilter} ariaLabel="Filter by decision" />

        <div className="relative flex shrink-0 items-center">
          {/* Pressed is a third state, distinct from hover: IconButton's
              `active` recipe tints the trigger for as long as the popover
              is open. */}
          <IconButton
            title="Filter"
            onClick={() => onFilterOpenChange(!filterOpen)}
            active={filterOpen}
            aria-haspopup="dialog"
            aria-expanded={filterOpen}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
            >
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46" />
            </svg>
            {filterActive && (
              <span
                aria-hidden
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
              {/* Undimmed click catcher, per the prototype's scrim. */}
              <div className="fixed inset-0 z-[39]" onClick={() => onFilterOpenChange(false)} />
              {/* The Inbox's popover, verbatim (ReviewList.tsx:221-483) — the
                  popover is app chrome, one language everywhere. History's
                  single addition is the Show archived row up top. */}
              <div
                className="absolute right-0 z-[40]"
                style={{
                  top: 38,
                  width: 236,
                  padding: 8,
                  background: "rgba(var(--gw-glass-rgb),.74)",
                  backdropFilter: "blur(18px) saturate(140%)",
                  WebkitBackdropFilter: "blur(18px) saturate(140%)",
                  border: "1px solid rgba(var(--gw-line-rgb),.14)",
                  borderRadius: 11,
                  boxShadow:
                    "0 18px 44px rgba(0,0,0,.5), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
                  maxHeight: 440,
                  overflowY: "auto",
                }}
              >
                <div className="flex items-center gap-2" style={{ padding: "4px 8px 8px" }}>
                  <Eyebrow>Filters</Eyebrow>
                  <span className="flex-1" />
                  {/* Always rendered, not conditionally mounted: `visibility`
                      (not a conditional) keeps this row's box — and every
                      row below it — the same height whether a filter is
                      active or not. A mounted/unmounted button made the
                      whole popover jump by a few px on every toggle, since
                      "Clear all"'s 11px line is taller than the eyebrow's
                      9px one. */}
                  <button
                    type="button"
                    onClick={onClearFilters}
                    tabIndex={filterActive ? 0 : -1}
                    aria-hidden={!filterActive}
                    className="cursor-pointer border-none bg-transparent p-0 text-[11px] font-medium transition-colors"
                    style={{
                      color: "var(--gw-blue-t)",
                      visibility: filterActive ? "visible" : "hidden",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gw-blue-h)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--gw-blue-t)")}
                  >
                    Clear all
                  </button>
                </div>

                <CheckRow
                  on={showArchived}
                  label="Show archived"
                  onClick={() => onShowArchived(!showArchived)}
                />

                <Rule margin="8px 8px" />
                <div style={{ padding: "0 8px 8px" }}>
                  <Eyebrow>Template</Eyebrow>
                </div>
                <div className="flex flex-col gap-[1px]">
                  {templateOptions.map((name) => (
                    <CheckRow
                      key={name}
                      mono
                      on={templateFilter.includes(name)}
                      label={name}
                      onClick={() => onToggleTemplate(name)}
                    />
                  ))}
                </div>

                <Rule margin="8px 8px" />
                <div style={{ padding: "0 8px 8px" }}>
                  <Eyebrow>Date range</Eyebrow>
                </div>
                <div className="flex flex-wrap" style={{ gap: 6, padding: "0 8px" }}>
                  {DATE_PRESETS.map((p) => {
                    const on = datePreset === p.key;
                    return (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => onDatePreset(on ? null : p.key)}
                        className="cursor-pointer transition-colors"
                        style={{
                          fontFamily: "inherit",
                          fontSize: 11.5,
                          fontWeight: 500,
                          padding: "5px 10px",
                          borderRadius: 7,
                          border: on
                            ? "1px solid rgba(var(--gw-line-rgb),.28)"
                            : "1px solid rgba(var(--gw-line-rgb),.12)",
                          color: on ? "var(--gw-t2)" : "var(--gw-t5)",
                          background: on ? "rgba(var(--gw-line-rgb),.1)" : "transparent",
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>

                {/* Custom range disclosure — replaces the prototype's two dead
                    From/To boxes with the inbox's working calendar. */}
                <button
                  type="button"
                  onClick={() => setCalOpen((o) => !o)}
                  className="flex cursor-pointer items-center border-none bg-transparent text-left"
                  style={{ gap: 8, margin: "8px 8px 0", padding: "6px 0", width: "calc(100% - 16px)" }}
                >
                  <span className="flex-1" style={{ fontSize: 12, color: "var(--gw-t5)" }}>
                    Custom range
                  </span>
                  <span
                    className="inline-flex"
                    style={{
                      transition: "transform .15s ease",
                      transform: calOpenEffective ? "rotate(180deg)" : "rotate(0deg)",
                    }}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--gw-t8)"
                      strokeWidth="2"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </span>
                </button>

                {calOpenEffective && (
                  <div style={{ padding: "6px 8px 4px" }}>
                    <div className="flex items-center" style={{ gap: 8, marginBottom: 10 }}>
                      <button
                        type="button"
                        aria-label="Previous month"
                        onClick={() => setCalMonth((m) => shiftMonth(m, -1))}
                        className="flex cursor-pointer items-center justify-center border-none bg-transparent text-t6 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.07)] hover:text-t3"
                        style={{ width: 24, height: 24, borderRadius: 7 }}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
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
                        aria-label="Next month"
                        onClick={() => setCalMonth((m) => shiftMonth(m, 1))}
                        className="flex cursor-pointer items-center justify-center border-none bg-transparent text-t6 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.07)] hover:text-t3"
                        style={{ width: 24, height: 24, borderRadius: 7 }}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
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
                          style={{ letterSpacing: ".04em", color: "var(--gw-t9)", padding: "2px 0" }}
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
                            onClick={() => cell.iso && onPickDay(cell.iso)}
                            className="flex cursor-pointer items-center justify-center border-none font-mono text-[11px]"
                            style={{
                              height: 26,
                              borderRadius: 6,
                              // Endpoint ink is the panel colour, not the
                              // inbox's raw #0a1a11: the endpoint fill is t3,
                              // which inverts between themes, so the ink has to
                              // invert with it.
                              color: cell.endpoint
                                ? "var(--gw-panel-a)"
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

        {/* Collapse list — panel icon, the only collapse control, exactly the
            Inbox's (ReviewList.tsx:487). */}
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
            <rect x="3" y="4" width="6.5" height="16" rx="2" fill="currentColor" stroke="none" />
          </svg>
        </IconButton>
      </div>

      {/* ── Search ── */}
      <ListSearchField
        value={query}
        onChange={onQuery}
        placeholder="Search history…"
        ariaLabel="Search history"
        inputRef={searchRef}
      />
    </div>
  );
}

/** Section eyebrow, the Inbox popover's (9px mono, .14em). */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-mono text-[9px] font-semibold uppercase"
      style={{ letterSpacing: ".14em", color: "var(--gw-t8)" }}
    >
      {children}
    </span>
  );
}

function Rule({ margin }: { margin: string }) {
  return <div style={{ height: 1, background: "rgba(var(--gw-line-rgb),.08)", margin }} />;
}

/**
 * One checkbox row, the Inbox popover's exactly (ReviewList.tsx:270-310):
 * 17px box, t3 fill when checked with panel-ink check, hover-tinted row.
 * `role="checkbox"` on a button rather than a native input: the box is a
 * styled square with a stroked polyline, and a native input cannot be
 * restyled that far.
 */
function CheckRow({
  on,
  label,
  mono,
  onClick,
}: {
  on: boolean;
  label: string;
  mono?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={onClick}
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
          border: on ? "1.5px solid var(--gw-t3)" : "1.5px solid rgba(var(--gw-line-rgb),.24)",
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
        className={
          mono
            ? "min-w-0 flex-1 truncate font-mono text-[11.5px]"
            : "min-w-0 flex-1 truncate text-[12px]"
        }
        style={{ color: "var(--gw-t4)" }}
      >
        {label}
      </span>
    </button>
  );
}

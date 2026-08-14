/**
 * NotesFilterPopover — the funnel's dropdown body: Tags, then Date range.
 *
 * Split out of NotesListHeader.tsx purely to stay
 * under this module's 300-line cap (eslint.config.mjs's
 * gatewerk/notes-module-300-line-cap) — the popover's markup alone is bigger
 * than the header shell that hosts it. No behaviour moved with it beyond
 * what NotesListHeader.tsx already delegated: the trigger button, its green
 * dot and Escape handling stay in that file, since those are properties of
 * the funnel, not of what is inside it.
 *
 * Tags section: verbatim from the app's tag-filter chrome. Date range
 * section: HistoryListHeader.tsx:242-417 ported verbatim (state, markup, and
 * the `pickDay`/`applyDatePreset` shapes History.tsx:171-185 uses) —
 * reusing the app's existing date range
 * language rather than inventing a new control. Popover chrome (glass .74,
 * blur(18) sat(140%), radius 11) is HistoryListHeader.tsx:176-192's, the same
 * chrome the "..." menus and DateRangePopover.tsx use.
 */

import { useState } from "react";
import {
  DATE_PRESETS,
  buildCalCells,
  currentMonth,
  fmtMonthLabel,
  shiftMonth,
} from "@gatewerk/web-core/lib/filter-dates";
import { toggleTag } from "./notes-model";

interface Props {
  tags: string[];
  activeTag: string | null;
  onTagChange: (tag: string | null) => void;
  datePreset: string | null;
  onDatePreset: (key: string | null) => void;
  dateFrom: string;
  dateTo: string;
  onPickDay: (iso: string) => void;
  onClearFilters: () => void;
  filterActive: boolean;
  onClose: () => void;
}

export function NotesFilterPopover({
  tags,
  activeTag,
  onTagChange,
  datePreset,
  onDatePreset,
  dateFrom,
  dateTo,
  onPickDay,
  onClearFilters,
  filterActive,
  onClose,
}: Props) {
  // Calendar month cursor and the custom-range disclosure's open state,
  // HistoryListHeader.tsx:83-84 verbatim — local to the popover, not lifted.
  const [calMonth, setCalMonth] = useState(currentMonth);
  const [calOpen, setCalOpen] = useState(false);

  // Disclosure opens itself once a custom range exists, same as History's
  // calOpenEffective (HistoryListHeader.tsx:111) — reopening the popover
  // must not hide a range that is already applied.
  const calOpenEffective = calOpen || !!dateFrom || !!dateTo;
  const calCells = buildCalCells(calMonth, dateFrom, dateTo);
  const rangeLabel =
    dateFrom && dateTo
      ? `${dateFrom}  →  ${dateTo}`
      : dateFrom
        ? `${dateFrom}  →  pick end`
        : "Pick a start date";

  return (
    <>
      {/* Undimmed click catcher (HistoryListHeader.tsx:171-172). */}
      <div className="fixed inset-0 z-[39]" onClick={onClose} />
      {/* Popover chrome, verbatim (HistoryListHeader.tsx:176-192). */}
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
          boxShadow: "0 18px 44px rgba(0,0,0,.5), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
          maxHeight: 440,
          overflowY: "auto",
        }}
      >
        {/* Single "Clear all" for the whole popover, History's own pattern
            (HistoryListHeader.tsx:193-218), replacing the old per-tag
            "Clear": a popover clear that left the date range on would be
            worse than no clear at all. Always mounted, `visibility` not
            conditional rendering, same reasoning as History's — an
            unmounted button changes this row's height and every row below
            it. */}
        <div className="flex items-center gap-2" style={{ padding: "4px 8px 8px" }}>
          <Eyebrow>Filters</Eyebrow>
          <span className="flex-1" />
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

        {tags.length > 0 && (
          <>
            <div style={{ padding: "0 8px 8px" }}>
              <Eyebrow>Tags</Eyebrow>
            </div>
            <div className="flex flex-col gap-[1px]">
              {tags.map((tag) => (
                <CheckRow
                  key={tag}
                  mono
                  on={tag === activeTag}
                  label={`#${tag}`}
                  onClick={() => onTagChange(toggleTag(activeTag, tag))}
                />
              ))}
            </div>
            <Rule margin="8px 8px" />
          </>
        )}

        {/* Date range — HistoryListHeader.tsx:242-417 ported verbatim: preset
            chips, then a custom-range disclosure with the same working
            calendar (buildCalCells etc. from filter-dates.ts, the shared
            helpers DateRangePopover.tsx also uses). */}
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
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--gw-t8)" strokeWidth="2">
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
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
              <span className="flex-1 text-center font-mono text-[11.5px] font-medium" style={{ color: "var(--gw-t3)" }}>
                {fmtMonthLabel(calMonth)}
              </span>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => setCalMonth((m) => shiftMonth(m, 1))}
                className="flex cursor-pointer items-center justify-center border-none bg-transparent text-t6 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.07)] hover:text-t3"
                style={{ width: 24, height: 24, borderRadius: 7 }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(7,1fr)", gap: 2, marginBottom: 4 }}>
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
                      color: cell.endpoint ? "var(--gw-panel-a)" : cell.inRange ? "var(--gw-t3)" : "var(--gw-t5)",
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
              style={{ gap: 8, marginTop: 9, paddingTop: 9, borderTop: "1px solid rgba(var(--gw-line-rgb),.07)" }}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]" style={{ color: "var(--gw-t6)" }}>
                {rangeLabel}
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** Section eyebrow, verbatim (HistoryListHeader.tsx:458-468). */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[9px] font-semibold uppercase" style={{ letterSpacing: ".14em", color: "var(--gw-t8)" }}>
      {children}
    </span>
  );
}

/** Section divider, verbatim (HistoryListHeader.tsx:470-472). */
function Rule({ margin }: { margin: string }) {
  return <div style={{ height: 1, background: "rgba(var(--gw-line-rgb),.08)", margin }} />;
}

/**
 * One checkbox row, verbatim (HistoryListHeader.tsx:474-537): 17px box, t3
 * fill when checked with panel-ink check, hover-tinted row.
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
          width: 17, height: 17, borderRadius: 5, flexShrink: 0,
          border: on ? "1.5px solid var(--gw-t3)" : "1.5px solid rgba(var(--gw-line-rgb),.24)",
          background: on ? "var(--gw-t3)" : "transparent",
        }}
      >
        {on && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--gw-green-ink)" strokeWidth="3.2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </span>
      <span
        className={mono ? "min-w-0 flex-1 truncate font-mono text-[11.5px]" : "min-w-0 flex-1 truncate text-[12px]"}
        style={{ color: "var(--gw-t4)" }}
      >
        {label}
      </span>
    </button>
  );
}

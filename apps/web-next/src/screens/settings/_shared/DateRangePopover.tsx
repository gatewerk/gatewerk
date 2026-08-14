/**
 * DateRangePopover — a themed calendar trigger for Settings' Activity and
 * Deliveries date-range filters, replacing a pair of native
 * `<input type="date">` elements. Native date inputs render the browser's
 * own picker chrome (light background, platform-native month nav), which
 * cannot be restyled and breaks the app's dark theme wherever it opens.
 *
 * The calendar markup and range-pick logic are the Inbox/History filter
 * popover's, ported rather than re-derived (ReviewList.tsx:359-431,
 * HistoryListHeader.tsx:295-406, History.tsx's `pickDay`) — floating layers
 * and date-range interaction are one language app-wide. Trimmed to just the
 * calendar: Settings' date range has no preset pills or template checklist
 * to disclose it behind, so it opens straight to the grid.
 */
import { useEffect, useState } from "react";
import { Calendar } from "lucide-react";
import {
  buildCalCells,
  currentMonth,
  fmtDayLabel,
  fmtMonthLabel,
  shiftMonth,
} from "@gatewerk/web-core/lib/filter-dates";
import { FILTER_CONTROL_CLASS } from "./ui";

interface Props {
  dateFrom: string;
  dateTo: string;
  onChange: (dateFrom: string, dateTo: string) => void;
}

export function DateRangePopover({ dateFrom, dateTo, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [calMonth, setCalMonth] = useState(() => (dateFrom ? dateFrom.slice(0, 7) : currentMonth()));

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  function pickDay(iso: string) {
    if (!dateFrom || (dateFrom && dateTo)) {
      onChange(iso, "");
    } else if (iso < dateFrom) {
      onChange(iso, dateFrom);
    } else {
      onChange(dateFrom, iso);
    }
  }

  const calCells = buildCalCells(calMonth, dateFrom, dateTo);
  const triggerLabel =
    dateFrom && dateTo
      ? `${fmtDayLabel(dateFrom)} → ${fmtDayLabel(dateTo)}`
      : dateFrom
        ? `${fmtDayLabel(dateFrom)} → …`
        : "Any time";
  const rangeLabel =
    dateFrom && dateTo
      ? `${dateFrom}  →  ${dateTo}`
      : dateFrom
        ? `${dateFrom}  →  pick end`
        : "Pick a start date";

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Filter by date range"
        onClick={() => setOpen((o) => !o)}
        className={`${FILTER_CONTROL_CLASS} flex cursor-pointer items-center justify-between gap-2`}
      >
        <span
          className={`truncate ${dateFrom ? "font-mono" : ""}`}
          style={{ color: dateFrom ? "var(--gw-t2)" : "var(--gw-t8)" }}
        >
          {triggerLabel}
        </span>
        <Calendar size={13} strokeWidth={1.8} className="shrink-0" style={{ color: "var(--gw-t8)" }} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[39]" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Pick a date range"
            className="absolute z-[40] mt-1"
            style={{
              width: 224,
              padding: 8,
              background: "rgba(var(--gw-glass-rgb),.74)",
              backdropFilter: "blur(18px) saturate(140%)",
              WebkitBackdropFilter: "blur(18px) saturate(140%)",
              border: "1px solid rgba(var(--gw-line-rgb),.14)",
              borderRadius: 11,
              boxShadow: "0 18px 44px rgba(0,0,0,.5), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
            }}
          >
            <div className="flex items-center" style={{ gap: 8, padding: "2px 2px 10px" }}>
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
              {(dateFrom || dateTo) && (
                <button
                  type="button"
                  onClick={() => onChange("", "")}
                  className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-[11px] font-medium transition-colors"
                  style={{ color: "var(--gw-blue-t)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gw-blue-h)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--gw-blue-t)")}
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

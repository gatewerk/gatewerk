/**
 * filter-dates.ts — pure date/calendar helpers for the list filter popover
 * (prototype filter popover, Mon-first calendar). No side effects.
 */
import type { Review } from "@gatewerk/web-core/api/reviews";

export const DATE_PRESETS: { key: string; label: string; days: number }[] = [
  { key: "today", label: "Today", days: 1 },
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "60d", label: "Last 60 days", days: 60 },
];

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function isoOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtMonthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTH_ABBR[m - 1]} ${y}`;
}

/** A bare `YYYY-MM-DD` as `Aug 4` — the compact form a date-range trigger
 *  button shows instead of echoing the raw ISO string. */
export function fmtDayLabel(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTH_ABBR[m - 1]} ${d}`;
}

export function shiftMonth(ym: string, delta: number): string {
  let [y, m] = ym.split("-").map(Number);
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${pad2(m)}`;
}

export interface CalCell {
  blank?: boolean;
  label: string;
  iso?: string;
  endpoint?: boolean;
  inRange?: boolean;
}

export function buildCalCells(ym: string, dateFrom: string, dateTo: string): CalCell[] {
  const [y, m] = ym.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const startDow = (first.getDay() + 6) % 7; // Mon-first
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells: CalCell[] = [];
  for (let i = 0; i < startDow; i++) cells.push({ blank: true, label: "" });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${y}-${pad2(m)}-${pad2(d)}`;
    const endpoint = iso === dateFrom || iso === dateTo;
    const inRange = !!dateFrom && !!dateTo && iso > dateFrom && iso < dateTo;
    cells.push({ label: String(d), iso, endpoint, inRange });
  }
  return cells;
}

/**
 * A bare `YYYY-MM-DD` from `<input type="date">` carries no timezone of its
 * own. `new Date(dateStr)` reads it as UTC midnight, which is the wrong
 * instant for anyone not in UTC — a reviewer in UTC-5 picking "Aug 4" would
 * have their filter's day boundary land at 7pm Aug 3 local time. Parsing the
 * y/m/d components into the multi-arg Date constructor instead builds the
 * instant from the BROWSER's local timezone, so "the day I picked" means the
 * reviewer's own calendar day. Used by server-side range filters (Activity,
 * Deliveries); History's own date filter is client-side and never needed
 * this — it compares local calendar-day strings directly (see `isoOf`).
 */
export function startOfDayIso(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

/** The end-of-day counterpart to `startOfDayIso` — a `to` filter of a bare
 *  date means through the end of that day, not its first instant. */
export function endOfDayIso(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

export function matchesDate(
  r: Review,
  datePreset: string | null,
  dateFrom: string,
  dateTo: string,
): boolean {
  if (!datePreset && !dateFrom && !dateTo) return true;
  const created = new Date(r.created_at);
  if (datePreset) {
    const days = DATE_PRESETS.find((p) => p.key === datePreset)?.days ?? 0;
    return created.getTime() >= Date.now() - days * 86_400_000;
  }
  const iso = isoOf(created);
  if (dateFrom && dateTo) return iso >= dateFrom && iso <= dateTo;
  if (dateFrom) return iso >= dateFrom;
  return true;
}

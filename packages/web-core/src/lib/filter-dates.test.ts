/**
 * filter-dates was promoted to a shared lib with two consumers (the Inbox list
 * filter and History's) and no direct coverage. These pin the two pieces that
 * are silently wrong rather than loudly broken when they drift: the Mon-first
 * grid offset and the month arithmetic that has to roll a year over.
 */
import { describe, expect, it } from "vitest";
import { buildCalCells, endOfDayIso, shiftMonth, startOfDayIso } from "./filter-dates";

describe("buildCalCells", () => {
  const days = (cells: ReturnType<typeof buildCalCells>) => cells.filter((c) => !c.blank);
  const blanks = (cells: ReturnType<typeof buildCalCells>) => cells.filter((c) => c.blank).length;

  it("offsets the first day to a Mon-first grid", () => {
    // 2026-08-01 is a Saturday: Mon-first puts it in column 6, so five blanks.
    expect(blanks(buildCalCells("2026-08", "", ""))).toBe(5);
  });

  it("puts a month starting on Monday flush against the left edge", () => {
    // 2026-06-01 is a Monday — column 1, no leading blanks at all.
    expect(blanks(buildCalCells("2026-06", "", ""))).toBe(0);
  });

  it("puts a month starting on Sunday in the last column, not the first", () => {
    // 2026-11-01 is a Sunday. A zero-indexed getDay() would place it first and
    // shift the whole month a week; Mon-first has to give it six blanks.
    expect(blanks(buildCalCells("2026-11", "", ""))).toBe(6);
  });

  it("counts the days in the month, including February in a leap year", () => {
    expect(days(buildCalCells("2024-02", "", "")).length).toBe(29);
    expect(days(buildCalCells("2026-02", "", "")).length).toBe(28);
    expect(days(buildCalCells("2026-01", "", "")).length).toBe(31);
    expect(days(buildCalCells("2026-04", "", "")).length).toBe(30);
  });

  it("zero pads the iso of a single digit day so string comparison holds", () => {
    // The range flags compare iso strings, so "2026-08-9" would sort after
    // "2026-08-10" and paint the wrong cells.
    expect(days(buildCalCells("2026-08", "", ""))[8].iso).toBe("2026-08-09");
  });

  it("marks both endpoints and only the days strictly between them", () => {
    const cells = days(buildCalCells("2026-08", "2026-08-10", "2026-08-13"));
    const byIso = (iso: string) => cells.find((c) => c.iso === iso);

    expect(byIso("2026-08-10")?.endpoint).toBe(true);
    expect(byIso("2026-08-13")?.endpoint).toBe(true);
    // Endpoints are drawn as endpoints, not as in-range fill.
    expect(byIso("2026-08-10")?.inRange).toBe(false);
    expect(byIso("2026-08-11")?.inRange).toBe(true);
    expect(byIso("2026-08-12")?.inRange).toBe(true);
    expect(byIso("2026-08-09")?.inRange).toBe(false);
    expect(byIso("2026-08-14")?.inRange).toBe(false);
  });

  it("marks a lone start date as an endpoint with nothing in range", () => {
    const cells = days(buildCalCells("2026-08", "2026-08-10", ""));
    expect(cells.find((c) => c.iso === "2026-08-10")?.endpoint).toBe(true);
    expect(cells.some((c) => c.inRange)).toBe(false);
  });

  it("marks nothing when the range is in another month", () => {
    const cells = days(buildCalCells("2026-08", "2026-09-01", "2026-09-05"));
    expect(cells.some((c) => c.endpoint || c.inRange)).toBe(false);
  });
});

describe("startOfDayIso / endOfDayIso", () => {
  // Asserting against LOCAL getters, not the UTC string itself — the whole
  // point of these functions is to land on the machine's own local midnight/
  // end-of-day, so a fixed-offset assertion would only hold in one timezone
  // and pass or fail depending on which machine runs the suite.
  it("startOfDayIso lands on local midnight of the given day", () => {
    const d = new Date(startOfDayIso("2026-08-04"));
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 7, 4]);
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([0, 0, 0]);
  });

  it("endOfDayIso lands on the last instant of local day, not the next day's midnight", () => {
    const d = new Date(endOfDayIso("2026-08-04"));
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 7, 4]);
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([23, 59, 59]);
  });

  it("end is strictly after start, so a from/to pair on the same day is a real range", () => {
    expect(new Date(endOfDayIso("2026-08-04")).getTime()).toBeGreaterThan(
      new Date(startOfDayIso("2026-08-04")).getTime(),
    );
  });

  it("handles a month/year rollover day correctly", () => {
    const start = new Date(startOfDayIso("2026-12-31"));
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 11, 31]);
  });
});

describe("shiftMonth", () => {
  it("steps within a year", () => {
    expect(shiftMonth("2026-06", 1)).toBe("2026-07");
    expect(shiftMonth("2026-06", -1)).toBe("2026-05");
  });

  it("rolls December forward into the next January", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("rolls January back into the previous December", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  it("zero pads the month so the ym string stays sortable and parseable", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-08", 1)).toBe("2026-09");
  });

  it("carries across more than one year in a single step", () => {
    expect(shiftMonth("2026-06", 25)).toBe("2028-07");
    expect(shiftMonth("2026-06", -25)).toBe("2024-05");
  });

  it("is a no-op for a zero delta", () => {
    expect(shiftMonth("2026-06", 0)).toBe("2026-06");
  });
});

import { describe, expect, it } from "vitest";
import { timeAgoShort } from "./utils";

describe("timeAgoShort", () => {
  const now = new Date("2026-08-01T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const MIN = 60_000, H = 3_600_000, D = 86_400_000;

  it("under a minute is 'now'", () => expect(timeAgoShort(ago(30_000), now)).toBe("now"));
  it("minutes", () => expect(timeAgoShort(ago(5 * MIN), now)).toBe("5m"));
  it("hours (design: 2h, 5h)", () => {
    expect(timeAgoShort(ago(2 * H), now)).toBe("2h");
    expect(timeAgoShort(ago(5 * H), now)).toBe("5h");
  });
  it("days start at 24h (design: 1d)", () => expect(timeAgoShort(ago(26 * H), now)).toBe("1d"));
  it("days run to 13 (design: 9d)", () => expect(timeAgoShort(ago(9 * D), now)).toBe("9d"));
  it("weeks from day 14 (design: 3wk)", () => {
    expect(timeAgoShort(ago(14 * D), now)).toBe("2wk");
    expect(timeAgoShort(ago(21 * D), now)).toBe("3wk");
  });
  it("months from week 9", () => expect(timeAgoShort(ago(70 * D), now)).toBe("2mo"));
  it("years from month 12", () => expect(timeAgoShort(ago(400 * D), now)).toBe("1y"));
  it("the 30-day month and the 365-day year meet without a gap", () => {
    // Months count 30-day months, years count 365-day years, so the handover
    // is not at the same day number. Anything in [360, 364] fell through the
    // `months < 12` guard and printed "0y".
    expect(timeAgoShort(ago(359 * D), now)).toBe("11mo");
    expect(timeAgoShort(ago(360 * D), now)).toBe("12mo");
    expect(timeAgoShort(ago(364 * D), now)).toBe("12mo");
    expect(timeAgoShort(ago(365 * D), now)).toBe("1y");
  });
  it("an unparseable timestamp says so instead of printing 'NaNy'", () =>
    expect(timeAgoShort("not a date", now)).toBe("unknown"));
  it("future timestamps clamp to 'now' (clock skew must not render negatives)", () =>
    expect(timeAgoShort(ago(-5 * MIN), now)).toBe("now"));
});

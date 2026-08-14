import { describe, expect, it } from "vitest";
import { usedDescription, verboseAgo } from "./recipient-state";

describe("usedDescription", () => {
  it("interpolates decision and date", () => {
    expect(usedDescription("approved", "2026-07-15T12:00:00.000Z")).toContain(
      "This review was approved on Jul 15, 2026.",
    );
  });

  it("falls back when the date or decision is missing", () => {
    const fallback = "This review has already been decided. No further action is needed.";
    expect(usedDescription("approved", undefined)).toBe(fallback);
    expect(usedDescription("unknown", "2026-07-15T12:00:00.000Z")).toBe(fallback);
    expect(usedDescription(undefined, "not-a-date")).toBe(fallback);
  });
});

describe("verboseAgo", () => {
  it("writes relative time as prose, singular and plural", () => {
    const ago = (ms: number) => verboseAgo(new Date(Date.now() - ms).toISOString());
    expect(ago(5_000)).toBe("just now");
    expect(ago(60_000)).toBe("1 minute ago");
    expect(ago(8 * 60_000)).toBe("8 minutes ago");
    expect(ago(3 * 3_600_000)).toBe("3 hours ago");
    expect(ago(2 * 86_400_000)).toBe("2 days ago");
  });
});

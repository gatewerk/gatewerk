import { describe, it, expect } from "vitest";
import { isNarrowWidth, NARROW_MAX_WIDTH, NARROW_MEDIA_QUERY } from "./narrow";

describe("isNarrowWidth", () => {
  it("treats a 390px phone as narrow", () => {
    expect(isNarrowWidth(390)).toBe(true);
  });

  it("treats 767px as narrow", () => {
    expect(isNarrowWidth(767)).toBe(true);
  });

  // The regression this file exists to hold. The breakpoint was 768 for one
  // afternoon; at 834 the desktop shell still measured its own 1120px minimum
  // and 286px of the app was clipped off the right edge. Every width below the
  // layout's declared floor has to get the phone layout, tablets included.
  it("treats an iPad in portrait as narrow, because the desktop layout needs 1120", () => {
    expect(isNarrowWidth(834)).toBe(true);
  });

  it("treats a landscape tablet at 1024 as narrow for the same reason", () => {
    expect(isNarrowWidth(1024)).toBe(true);
  });

  it("treats 1119 as narrow, one pixel below what the desktop layout needs", () => {
    expect(isNarrowWidth(1119)).toBe(true);
  });

  it("treats the breakpoint itself as wide, so 1120 gets the desktop app", () => {
    expect(isNarrowWidth(NARROW_MAX_WIDTH)).toBe(false);
  });

  it("treats a 1280px laptop as wide", () => {
    expect(isNarrowWidth(1280)).toBe(false);
  });

  it("does not report narrow for a nonsense width, so a bad measurement fails to desktop", () => {
    expect(isNarrowWidth(0)).toBe(false);
    expect(isNarrowWidth(Number.NaN)).toBe(false);
  });

  it("builds a media query that agrees with the predicate", () => {
    expect(NARROW_MEDIA_QUERY).toBe(`(max-width: ${NARROW_MAX_WIDTH - 1}px)`);
    expect(NARROW_MEDIA_QUERY).toBe("(max-width: 1119px)");
  });
});

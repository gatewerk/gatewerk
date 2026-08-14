// One parser shared by the ?limit&offset list routes (login-history,
// feedback, webhook-deliveries). Guards the clamping contract those routes
// depend on: limit in (0, maxLimit], non-numeric/absent falls back to
// defaultLimit; offset >= 0, non-numeric/absent falls back to 0.
//
// Named pagination-parser.test.ts (not pagination.test.ts) because that
// filename is already taken by a pre-existing suite covering reviewService's
// own pagination behavior — a different subject, kept untouched here.

import { describe, it, expect } from "vitest";
import { parsePagination } from "../lib/pagination";

describe("parsePagination", () => {
  it("defaults to limit 50, offset 0 when params are absent", () => {
    expect(parsePagination({})).toEqual({ limit: 50, offset: 0 });
  });

  it("clamps a limit above maxLimit down to maxLimit", () => {
    expect(parsePagination({ limit: "200" }, { maxLimit: 100 })).toEqual({
      limit: 100,
      offset: 0,
    });
  });

  it("falls back to the default limit for limit=0", () => {
    expect(parsePagination({ limit: "0" })).toEqual({ limit: 50, offset: 0 });
  });

  it("falls back to the default limit for a negative limit", () => {
    expect(parsePagination({ limit: "-5" })).toEqual({ limit: 50, offset: 0 });
  });

  it("falls back to the default limit for a non-numeric limit", () => {
    expect(parsePagination({ limit: "abc" })).toEqual({ limit: 50, offset: 0 });
  });

  it("falls back to offset 0 for a negative offset", () => {
    expect(parsePagination({ offset: "-3" })).toEqual({ limit: 50, offset: 0 });
  });

  it("falls back to offset 0 for a non-numeric offset", () => {
    expect(parsePagination({ offset: "abc" })).toEqual({ limit: 50, offset: 0 });
  });

  it("honors a custom defaultLimit", () => {
    expect(parsePagination({}, { defaultLimit: 25 })).toEqual({ limit: 25, offset: 0 });
  });
});

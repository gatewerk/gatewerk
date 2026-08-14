import { describe, it, expect } from "vitest";
import { ReviewCreateBodySchema, ReviewVetoBodySchema } from "../reviews";

const base = { template: "deploy", payload: { a: 1 } };

describe("oversight wire rules", () => {
  it("defaults to absent (blocking) and accepts explicit values", () => {
    expect(ReviewCreateBodySchema.safeParse(base).success).toBe(true);
    expect(ReviewCreateBodySchema.safeParse({ ...base, oversight: "monitoring", callback_url: "https://a.example/cb", irreversibility: "reversible", timeout: { seconds: 300 } }).success).toBe(true);
    expect(ReviewCreateBodySchema.safeParse({ ...base, oversight: "bogus" }).success).toBe(false);
  });

  it("forbids timeout.action when oversight is monitoring", () => {
    const r = ReviewCreateBodySchema.safeParse({ ...base, oversight: "monitoring", timeout: { action: "expire", seconds: 300 } });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(["timeout", "action"]);
    }
  });

  it("accepts seconds-only timeout for monitoring", () => {
    const r = ReviewCreateBodySchema.safeParse({ ...base, oversight: "monitoring", timeout: { seconds: 300 } });
    expect(r.success).toBe(true);
  });

  it("still requires timeout.action for blocking timeouts (legacy shape preserved)", () => {
    const r = ReviewCreateBodySchema.safeParse({ ...base, timeout: { seconds: 300 } });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(["timeout", "action"]);
    }
  });

  it("veto body accepts an optional note", () => {
    expect(ReviewVetoBodySchema.safeParse({}).success).toBe(true);
    expect(ReviewVetoBodySchema.safeParse({ note: "wrong channel" }).success).toBe(true);
  });
});

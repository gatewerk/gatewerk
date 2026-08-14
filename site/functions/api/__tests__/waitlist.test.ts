import { describe, it, expect } from "vitest";
import { validateBody } from "../waitlist.js";

describe("validateBody", () => {
  it("accepts newsletter source without a tier", () => {
    const r = validateBody({ email: "a@b.com", source: "newsletter" });
    expect("error" in r).toBe(false);
  });
  it("requires a valid tier for waitlist source", () => {
    const r = validateBody({ email: "a@b.com", source: "waitlist" });
    expect("error" in r).toBe(true);
  });
  it("rejects community/solo as a waitlist tier", () => {
    const r = validateBody({ email: "a@b.com", tier: "community", source: "waitlist" });
    expect("error" in r).toBe(true);
  });
  it("accepts team as a waitlist tier", () => {
    const r = validateBody({ email: "a@b.com", tier: "team", source: "waitlist" });
    expect("error" in r).toBe(false);
  });
});

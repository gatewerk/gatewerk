import { describe, it, expect } from "vitest";
import { maskEmail } from "./mask-email";

describe("maskEmail", () => {
  it("keeps the first character and the whole domain", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
  });

  it("never emits the local part beyond its first character", () => {
    // The point of the function: the local part is the PII. Assert the rest of
    // it is genuinely absent rather than merely that the output looks masked.
    const masked = maskEmail("verylongname@example.com");
    expect(masked).not.toContain("erylongname");
    expect(masked).toBe("v***@example.com");
  });

  it("masks a single character local part without revealing it is short", () => {
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
  });

  it("returns an empty string for null or undefined, not a placeholder", () => {
    // A placeholder would itself reveal that no address was pinned.
    expect(maskEmail(null)).toBe("");
    expect(maskEmail(undefined)).toBe("");
    expect(maskEmail("")).toBe("");
  });

  it("leaves a value with no @ untouched rather than inventing structure", () => {
    expect(maskEmail("not-an-address")).toBe("not-an-address");
  });

  it("does not treat a leading @ as a local part", () => {
    expect(maskEmail("@example.com")).toBe("@example.com");
  });
});

import { describe, it, expect } from "vitest";
import { generateOtpCode, hashOtpCode, verifyOtpCode } from "../codes";

describe("email-otp/codes", () => {
  describe("generateOtpCode", () => {
    it("returns a 6-digit numeric string", () => {
      for (let i = 0; i < 100; i++) {
        const code = generateOtpCode();
        expect(code).toMatch(/^\d{6}$/);
      }
    });

    it("zero-pads codes drawn from the low end of the keyspace", () => {
      // Statistical: across 5_000 draws we expect ~30 codes < 100_000
      // (probability 0.1). Spot-check that any such draw is padded
      // rather than rendered as a short string.
      for (let i = 0; i < 5_000; i++) {
        const code = generateOtpCode();
        expect(code.length).toBe(6);
      }
    });
  });

  describe("hashOtpCode", () => {
    it("is deterministic for a given input", () => {
      const a = hashOtpCode("123456");
      const b = hashOtpCode("123456");
      expect(a).toBe(b);
    });

    it("returns a 64-char hex digest (SHA-256)", () => {
      const hash = hashOtpCode("000000");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces distinct hashes for distinct inputs", () => {
      expect(hashOtpCode("123456")).not.toBe(hashOtpCode("123457"));
    });
  });

  describe("verifyOtpCode", () => {
    it("returns true for a matching code", () => {
      const stored = hashOtpCode("987654");
      expect(verifyOtpCode("987654", stored)).toBe(true);
    });

    it("returns false for a non-matching code", () => {
      const stored = hashOtpCode("987654");
      expect(verifyOtpCode("987653", stored)).toBe(false);
    });

    it("returns false for an empty input", () => {
      const stored = hashOtpCode("987654");
      expect(verifyOtpCode("", stored)).toBe(false);
    });

    it("returns false for a malformed-shape input without throwing", () => {
      const stored = hashOtpCode("987654");
      expect(() => verifyOtpCode("not-a-code", stored)).not.toThrow();
      expect(verifyOtpCode("not-a-code", stored)).toBe(false);
    });

    it("returns false when the stored hash is shorter than expected", () => {
      // Defense: a corrupted DB row with a half-length hex value should
      // not crash the verify path — length-mismatch buffers cannot be
      // passed to timingSafeEqual, the function returns false.
      const truncated = hashOtpCode("987654").slice(0, 32);
      expect(verifyOtpCode("987654", truncated)).toBe(false);
    });
  });
});

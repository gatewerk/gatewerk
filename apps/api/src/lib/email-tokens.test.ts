import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateEmailToken, verifyEmailToken } from "./email-tokens";

// Mock the config module so tests are not dependent on real secrets
vi.mock("../config", () => ({
  config: {
    hmacSecret: "test-hmac-secret-for-email-tokens",
  },
}));

describe("email-tokens", () => {
  describe("verify-email purpose", () => {
    it("round-trips a verify-email token", () => {
      const token = generateEmailToken(
        { reviewer_id: "r1", email: "a@example.com", purpose: "verify-email" },
        60_000,
      );
      const payload = verifyEmailToken(token, "verify-email");
      expect(payload).not.toBeNull();
      expect(payload?.purpose).toBe("verify-email");
      expect(payload?.reviewer_id).toBe("r1");
    });

    it("returns null for wrong purpose", () => {
      const token = generateEmailToken(
        { reviewer_id: "r1", email: "a@example.com", purpose: "verify-email" },
        60_000,
      );
      expect(verifyEmailToken(token, "reset-password")).toBeNull();
    });
  });

  describe("digest_unsubscribe purpose", () => {
    it("round-trips a digest_unsubscribe token", () => {
      const token = generateEmailToken(
        { reviewer_id: "r2", email: "b@example.com", purpose: "digest_unsubscribe" },
        60_000,
      );
      const payload = verifyEmailToken(token, "digest_unsubscribe");
      expect(payload).not.toBeNull();
      expect(payload?.purpose).toBe("digest_unsubscribe");
      expect(payload?.reviewer_id).toBe("r2");
      expect(payload?.email).toBe("b@example.com");
    });

    it("fails verifyEmailToken with wrong purpose (verify-email)", () => {
      const token = generateEmailToken(
        { reviewer_id: "r2", email: "b@example.com", purpose: "digest_unsubscribe" },
        60_000,
      );
      expect(verifyEmailToken(token, "verify-email")).toBeNull();
    });

    it("fails verifyEmailToken on a tampered token", () => {
      const token = generateEmailToken(
        { reviewer_id: "r2", email: "b@example.com", purpose: "digest_unsubscribe" },
        60_000,
      );
      // Corrupt the signature portion
      const tampered = token.slice(0, -4) + "XXXX";
      expect(verifyEmailToken(tampered, "digest_unsubscribe")).toBeNull();
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import {
  signRecipientSession,
  verifyRecipientSession,
  RECIPIENT_SESSION_AUDIENCE,
  RECIPIENT_SESSION_ISSUER,
  RECIPIENT_SESSION_TTL_SECONDS,
} from "..";
import { config } from "../../../config";

describe("token-recipient-session", () => {
  describe("signRecipientSession + verifyRecipientSession", () => {
    it("round-trips successfully when the subject matches", () => {
      const tokenId = "gw_tok_abc123";
      const signed = signRecipientSession({ sub: tokenId, email: "alice@example.com" });
      const verified = verifyRecipientSession(signed, tokenId);
      expect(verified).not.toBeNull();
      expect(verified?.sub).toBe(tokenId);
      expect(verified?.email).toBe("alice@example.com");
    });

    it("returns null when the expected subject does not match", () => {
      const signed = signRecipientSession({
        sub: "gw_tok_alice",
        email: "alice@example.com",
      });
      const verified = verifyRecipientSession(signed, "gw_tok_bob");
      expect(verified).toBeNull();
    });

    it("returns null on a tampered signature", () => {
      const signed = signRecipientSession({
        sub: "gw_tok_abc",
        email: "alice@example.com",
      });
      const parts = signed.split(".");
      // Flip the FIRST char of the signature segment. The first base64url char
      // carries 6 fully-meaningful bits of byte 0, so changing it always alters
      // the decoded HMAC. (Flipping the LAST char is unreliable: a 32-byte HMAC's
      // final base64url char has 2 padding bits, so several chars decode to the
      // same bytes — the old `slice(0,-1)+"A"` tamper was a ~6% flaky no-op.)
      const sig = parts[2];
      const tampered = `${parts[0]}.${parts[1]}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
      expect(verifyRecipientSession(tampered, "gw_tok_abc")).toBeNull();
    });

    it("returns null when the token is expired", () => {
      vi.useFakeTimers();
      try {
        const tokenId = "gw_tok_expired";
        const signed = signRecipientSession({
          sub: tokenId,
          email: "alice@example.com",
        });
        // Advance past the 30-minute TTL plus 1s clock skew.
        vi.advanceTimersByTime((RECIPIENT_SESSION_TTL_SECONDS + 1) * 1000);
        expect(verifyRecipientSession(signed, tokenId)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns null when the audience claim is wrong", () => {
      const tokenId = "gw_tok_aud";
      // Sign with a different audience to simulate a leaked main-app
      // session being reused as a recipient cookie.
      const wrongAudience = jwt.sign({ email: "x@example.com" }, config.jwtSecret, {
        algorithm: "HS256",
        audience: "user",
        issuer: RECIPIENT_SESSION_ISSUER,
        subject: tokenId,
        expiresIn: RECIPIENT_SESSION_TTL_SECONDS,
      });
      expect(verifyRecipientSession(wrongAudience, tokenId)).toBeNull();
    });

    it("returns null when the issuer claim is wrong", () => {
      const tokenId = "gw_tok_iss";
      const wrongIssuer = jwt.sign({ email: "x@example.com" }, config.jwtSecret, {
        algorithm: "HS256",
        audience: RECIPIENT_SESSION_AUDIENCE,
        issuer: "evil-issuer",
        subject: tokenId,
        expiresIn: RECIPIENT_SESSION_TTL_SECONDS,
      });
      expect(verifyRecipientSession(wrongIssuer, tokenId)).toBeNull();
    });

    it("never throws on malformed input", () => {
      expect(() => verifyRecipientSession("not-a-jwt", "gw_tok_abc")).not.toThrow();
      expect(verifyRecipientSession("not-a-jwt", "gw_tok_abc")).toBeNull();
      expect(verifyRecipientSession("", "gw_tok_abc")).toBeNull();
    });
  });
});

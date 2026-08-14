/**
 * Webhook signature byte-parity test.
 *
 * V1 format : sha256=<hex>             where hex = HMAC(secret, body)
 * V2 format : t=<ts>,v1=<hex>          where hex = HMAC(secret, `${ts}.${body}`)
 *
 * Receivers verifying signatures with the prior code path MUST continue
 * accepting signatures from the migrated code. Sign 10 random
 * (body, secret, timestamp) tuples with BOTH paths and assert hex equality.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { hmacSha256 } from "../../lib/crypto";

describe("webhook signature parity — pre/post @noble/hashes migration", () => {
  function randomBody(seed: number, length: number): string {
    let s = "";
    for (let i = 0; i < length; i++) s += String.fromCharCode(32 + ((seed * 31 + i * 7) % 95));
    return s;
  }

  function randomSecret(seed: number): string {
    let s = "";
    for (let i = 0; i < 32; i++) s += String.fromCharCode(48 + ((seed * 13 + i) % 75));
    return s;
  }

  it("V1: HMAC(secret, body) byte-identical across 10 random tuples", () => {
    for (let i = 0; i < 10; i++) {
      const body = randomBody(i + 1, 100 + (i * 37) % 500);
      const secret = randomSecret(i + 2);
      // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — test-only deterministic secret; both sides use identical key for parity assertion
      const nodeHex = createHmac("sha256", secret).update(body).digest("hex");
      const nobleHex = hmacSha256(secret, body);
      expect(nobleHex).toBe(nodeHex);
    }
  });

  it("V2: HMAC(secret, `${ts}.${body}`) byte-identical across 10 random tuples", () => {
    for (let i = 0; i < 10; i++) {
      const body = randomBody(i + 1, 100 + (i * 37) % 500);
      const secret = randomSecret(i + 2);
      const ts = 1704067200 + i * 86400;
      const input = `${ts}.${body}`;
      // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — test-only deterministic secret; both sides use identical key for parity assertion
      const nodeHex = createHmac("sha256", secret).update(input).digest("hex");
      const nobleHex = hmacSha256(secret, input);
      expect(nobleHex).toBe(nodeHex);
    }
  });
});

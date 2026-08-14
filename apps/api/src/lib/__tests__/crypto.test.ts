import { describe, it, expect } from "vitest";
import { createHmac, timingSafeEqual } from "crypto";
import { hmacSha256, hmacSha256Base64url, constantTimeEqual } from "../crypto";

const SECRET = "test-secret-key-for-parity-verification";

/** The 9 parity inputs that must produce byte-identical output. */
const PARITY_INPUTS: Array<{ name: string; data: string }> = [
  { name: "empty string", data: "" },
  { name: "1 byte", data: "a" },
  { name: "exactly 64 bytes (SHA-256 block size)", data: "a".repeat(64) },
  { name: "65 bytes (block + 1, exercises multi-block path)", data: "a".repeat(65) },
  { name: "256 bytes (4 full blocks)", data: "z".repeat(256) },
  {
    name: "1KB pseudo-random",
    data: (() => {
      let s = "";
      // Deterministic non-trivial bytes — avoid Math.random for test determinism
      for (let i = 0; i < 1024; i++) s += String.fromCharCode(32 + ((i * 31 + 7) % 95));
      return s;
    })(),
  },
  { name: "multi-line with newlines", data: "line one\nline two\r\nline three\n" },
  {
    name: "UTF-8 multibyte (CJK + emoji + diacritics)",
    data: "action|アクション|résumé|🦊|2026-05-23",
  },
];

describe("hmacSha256 — parity with Node crypto.createHmac (byte-identical)", () => {
  for (const { name, data } of PARITY_INPUTS) {
    it(`produces identical hex for ${name}`, () => {
      // SECRET is a test-only parity constant, never used in production code paths.
      const node = createHmac("sha256", SECRET).update(data).digest("hex"); // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
      const noble = hmacSha256(SECRET, data);
      expect(noble).toBe(node);
    });
  }

  it("is sensitive to key differences (sanity)", () => {
    expect(hmacSha256("key-a", "data")).not.toBe(hmacSha256("key-b", "data"));
  });

  it("is sensitive to data differences (sanity)", () => {
    expect(hmacSha256(SECRET, "data-a")).not.toBe(hmacSha256(SECRET, "data-b"));
  });
});

describe("hmacSha256 — RFC 4231 known-answer test (correctness vs spec)", () => {
  // RFC 4231 Test Case 1 — proves the wrapper is correct against the HMAC-SHA256 spec,
  // not just consistent with Node's crypto module.
  //   Key  : 20 bytes of 0x0b
  //   Data : "Hi There"
  //   HMAC : b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7
  it("matches RFC 4231 Test Case 1 (Hi There with 0x0b*20 key)", () => {
    const key = "\x0b".repeat(20);
    const data = "Hi There";
    const expected = "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7";
    expect(hmacSha256(key, data)).toBe(expected);
  });
});

describe("hmacSha256Base64url — parity with Node crypto.createHmac base64url", () => {
  for (const { name, data } of PARITY_INPUTS) {
    it(`produces identical base64url for ${name}`, () => {
      const node = createHmac("sha256", SECRET).update(data).digest("base64url"); // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
      const noble = hmacSha256Base64url(SECRET, data);
      expect(noble).toBe(node);
    });
  }
});

describe("constantTimeEqual — correctness vs Node crypto.timingSafeEqual", () => {
  // 20-pair input matrix: equal / 1-byte diff / all-diff / different-length / boundary cases.
  // Length-mismatch contract: prior code (timingSafeEqual) throws; our wrapper returns false.
  // This is a deliberate improvement — all callers pass equal-length hex outputs.

  it("returns true for identical 64-char hex (1)", () => {
    const h = hmacSha256(SECRET, "x");
    expect(constantTimeEqual(h, h)).toBe(true);
    // Verify the parallel-universe Node behavior (constant-length so no throw).
    expect(timingSafeEqual(Buffer.from(h), Buffer.from(h))).toBe(true);
  });

  it("returns false for 1-byte-different 64-char hex (1)", () => {
    const a = hmacSha256(SECRET, "x");
    const b = a.slice(0, -1) + (a.endsWith("a") ? "b" : "a");
    expect(constantTimeEqual(a, b)).toBe(false);
    expect(timingSafeEqual(Buffer.from(a), Buffer.from(b))).toBe(false);
  });

  it("returns false for fully-different 64-char hex (1)", () => {
    const a = hmacSha256(SECRET, "x");
    const b = hmacSha256(SECRET, "y");
    expect(constantTimeEqual(a, b)).toBe(false);
    expect(timingSafeEqual(Buffer.from(a), Buffer.from(b))).toBe(false);
  });

  it("returns false for different-length strings without throwing (different from Node)", () => {
    // Node's timingSafeEqual throws RangeError on length mismatch. Our wrapper
    // returns false. This is deliberate and documented.
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(() => timingSafeEqual(Buffer.from("abc"), Buffer.from("abcd"))).toThrow();
  });

  it("returns true for two empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("returns false for empty vs non-empty (length differ)", () => {
    expect(constantTimeEqual("", "abc")).toBe(false);
    expect(constantTimeEqual("abc", "")).toBe(false);
  });

  // Generate 15 additional random equal-length pairs to push the matrix past 20.
  it("matches Node timingSafeEqual across 15 random equal-length 64-char hex pairs", () => {
    for (let i = 0; i < 15; i++) {
      const a = hmacSha256(SECRET, `seed-a-${i}`);
      const b = i % 3 === 0 ? a : hmacSha256(SECRET, `seed-b-${i}`);
      const ourResult = constantTimeEqual(a, b);
      const nodeResult = timingSafeEqual(Buffer.from(a), Buffer.from(b));
      expect(ourResult).toBe(nodeResult);
    }
  });
});

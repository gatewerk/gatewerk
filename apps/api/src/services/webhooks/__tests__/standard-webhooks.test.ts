import { describe, it, expect } from "vitest";
import {
  computeSwhSignature,
  buildSwhHeaders,
  buildSwhHeadersMultiKey,
  verifySwhSignature,
  resolveActiveSecrets,
  type SigningKeyRecord,
} from "../standard-webhooks";

describe("Standard Webhooks signing", () => {
  const SECRET = "my-test-secret"; // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — Standard Webhooks spec test vector, not a production secret
  const ID = "evt_test_001";
  const BODY = '{"type":"review.decided"}';
  const TS = 1_700_000_000;

  it("buildSwhHeaders produces correct header names", () => {
    const headers = buildSwhHeaders(ID, BODY, SECRET, TS);
    expect(headers["webhook-id"]).toBe(ID);
    expect(headers["webhook-timestamp"]).toBe(String(TS));
    expect(headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
  });

  it("computeSwhSignature is deterministic for fixed inputs", () => {
    const a = computeSwhSignature(ID, TS, BODY, SECRET);
    const b = computeSwhSignature(ID, TS, BODY, SECRET);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("verifySwhSignature accepts a valid signature", () => {
    const headers = buildSwhHeaders(ID, BODY, SECRET, TS);
    const valid = verifySwhSignature({
      webhookId: ID,
      webhookTimestamp: headers["webhook-timestamp"],
      webhookSignature: headers["webhook-signature"],
      body: BODY,
      secrets: [SECRET],
      toleranceSeconds: Infinity,
    });
    expect(valid).toBe(true);
  });

  it("verifySwhSignature rejects a wrong secret", () => {
    const headers = buildSwhHeaders(ID, BODY, SECRET, TS);
    const valid = verifySwhSignature({
      webhookId: ID,
      webhookTimestamp: headers["webhook-timestamp"],
      webhookSignature: headers["webhook-signature"],
      body: BODY,
      secrets: ["wrong-secret"], // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — negative-test fixture, not a production secret
      toleranceSeconds: Infinity,
    });
    expect(valid).toBe(false);
  });

  it("verifySwhSignature rejects stale timestamps", () => {
    const staleTs = Math.floor(Date.now() / 1000) - 400;
    const headers = buildSwhHeaders(ID, BODY, SECRET, staleTs);
    const valid = verifySwhSignature({
      webhookId: ID,
      webhookTimestamp: headers["webhook-timestamp"],
      webhookSignature: headers["webhook-signature"],
      body: BODY,
      secrets: [SECRET],
      toleranceSeconds: 300,
    });
    expect(valid).toBe(false);
  });

  it("verifySwhSignature rejects future-skewed timestamps beyond tolerance", () => {
    const futureTs = Math.floor(Date.now() / 1000) + 400;
    const headers = buildSwhHeaders(ID, BODY, SECRET, futureTs);
    const valid = verifySwhSignature({
      webhookId: ID,
      webhookTimestamp: headers["webhook-timestamp"],
      webhookSignature: headers["webhook-signature"],
      body: BODY,
      secrets: [SECRET],
      toleranceSeconds: 300,
    });
    expect(valid).toBe(false);
  });

  it("verifySwhSignature rejects malformed timestamp (NaN)", () => {
    expect(
      verifySwhSignature({
        webhookId: ID,
        webhookTimestamp: "not-a-number",
        webhookSignature: "v1,xxxx",
        body: BODY,
        secrets: [SECRET],
        toleranceSeconds: Infinity,
      })
    ).toBe(false);
  });

  it("verifySwhSignature rejects non-integer timestamp '1700000000.5'", () => {
    expect(
      verifySwhSignature({
        webhookId: ID,
        webhookTimestamp: "1700000000.5",
        webhookSignature: "v1,xxxx",
        body: BODY,
        secrets: [SECRET],
        toleranceSeconds: Infinity,
      })
    ).toBe(false);
  });

  it("verifySwhSignature: same inputs always produce same boolean result (determinism)", () => {
    const headers = buildSwhHeaders(ID, BODY, SECRET, TS);
    const args = {
      webhookId: ID,
      webhookTimestamp: headers["webhook-timestamp"],
      webhookSignature: headers["webhook-signature"],
      body: BODY,
      secrets: [SECRET],
      toleranceSeconds: Infinity,
    };
    const r1 = verifySwhSignature(args);
    const r2 = verifySwhSignature(args);
    const r3 = verifySwhSignature(args);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(r1).toBe(true); // valid path
  });

  it("buildSwhHeadersMultiKey includes both signatures and accepts either secret", () => {
    const SECRET2 = "new-secret"; // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — Standard Webhooks rotation fixture, not a production secret
    const headers = buildSwhHeadersMultiKey(ID, BODY, [SECRET, SECRET2], TS);
    expect(headers["webhook-signature"].split(" ")).toHaveLength(2);

    const validOld = verifySwhSignature({
      webhookId: ID,
      webhookTimestamp: headers["webhook-timestamp"],
      webhookSignature: headers["webhook-signature"],
      body: BODY,
      secrets: [SECRET],
      toleranceSeconds: Infinity,
    });
    const validNew = verifySwhSignature({
      webhookId: ID,
      webhookTimestamp: headers["webhook-timestamp"],
      webhookSignature: headers["webhook-signature"],
      body: BODY,
      secrets: [SECRET2],
      toleranceSeconds: Infinity,
    });
    expect(validOld).toBe(true);
    expect(validNew).toBe(true);
  });
});

describe("resolveActiveSecrets key rotation", () => {
  function makeKey(overrides: Partial<SigningKeyRecord>): SigningKeyRecord {
    return {
      id: "1",
      project_id: "p",
      key_id: "k1",
      secret: "default-secret", // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — rotation-test default, not a production secret
      status: "active",
      rotated_at: null,
      created_at: new Date(),
      ...overrides,
    };
  }

  it("includes active key", () => {
    const keys = [makeKey({ secret: "active-secret" })]; // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — rotation-test fixture, not a production secret
    expect(resolveActiveSecrets(keys)).toEqual(["active-secret"]);
  });

  it("includes previous key within overlap window", () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const keys = [
      makeKey({ id: "1", secret: "active-secret" }), // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — rotation-test fixture
      makeKey({ id: "2", key_id: "k0", secret: "prev-secret", status: "previous", rotated_at: recent }), // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — rotation-test fixture
    ];
    const result = resolveActiveSecrets(keys);
    expect(result).toContain("active-secret");
    expect(result).toContain("prev-secret");
  });

  it("excludes previous key outside overlap window", () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
    const keys = [
      makeKey({ id: "2", key_id: "k0", secret: "expired-secret", status: "previous", rotated_at: old }), // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — rotation-test fixture
    ];
    expect(resolveActiveSecrets(keys)).toEqual([]);
  });

  it("excludes revoked keys", () => {
    const keys = [
      makeKey({ id: "3", key_id: "k0", secret: "revoked-secret", status: "revoked", rotated_at: new Date() }), // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — rotation-test fixture
    ];
    expect(resolveActiveSecrets(keys)).toEqual([]);
  });

  it("excludes previous key with null rotated_at (safety)", () => {
    const keys = [
      makeKey({ id: "4", status: "previous", rotated_at: null }),
    ];
    expect(resolveActiveSecrets(keys)).toEqual([]);
  });
});

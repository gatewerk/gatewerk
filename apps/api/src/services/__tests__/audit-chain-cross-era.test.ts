/**
 * Audit chain cross-era validation test.
 *
 * Proves that migrating audit.ts from Node crypto.createHmac to
 * lib/crypto.hmacSha256 does not change the on-disk signature byte format,
 * AND that the verifier can handle mixed v1 + v2 rows in the same chain.
 *
 * v1Input / v2Input are module-internal helpers, so we use two complementary
 * approaches:
 *
 *   A) Parity-reduction: assert hmacSha256(key, X) === createHmac("sha256", key).update(X).digest("hex")
 *      for the input strings the audit module constructs internally. This is
 *      redundant with lib/__tests__/crypto.test.ts but confirms the import
 *      wiring works in this module's context.
 *
 *   B) Cross-era integration (I3 fix): insert 2 raw v1-format rows directly via
 *      db.insert() with Node-crypto-computed HMAC signatures, then insert 2 v2 rows
 *      via the migrated auditService.log() API (which naturally chains from the last
 *      v1 row), then call auditService.verify() on the mixed chain. Proves every
 *      existing on-disk v1 row will continue to validate post-deploy and that the
 *      v1→v2 chain boundary is correctly traversed.
 *
 * I3 fix: the prior version only inserted post-migration v2 rows (redundant with
 * the wrapper-level parity in lib/__tests__/crypto.test.ts). The real cross-era
 * property requires pre-migration v1 rows to coexist with post-migration v2 rows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "crypto";
import { hmacSha256 } from "../../lib/crypto";
import { createAuditService } from "../audit";
import { createTestDb } from "../../__tests__/helpers/test-db";
import { auditLog } from "@gatewerk/db/src/schema/audit-log";
import { isNull } from "drizzle-orm";
import { generateId } from "@gatewerk/shared";
import type { AuditAction } from "@gatewerk/shared";
import { config } from "../../config";

// Mirror the module-internal v1Input helper for test use.
// Must never diverge from the production implementation in audit.ts.
function buildV1Input(row: {
  action: string;
  actor: string;
  resource_type: string;
  resource_id?: string | null;
  details?: unknown;
  created_at: Date;
}): string {
  return [
    row.action,
    row.actor,
    row.resource_type,
    row.resource_id || "",
    JSON.stringify(row.details || {}),
    row.created_at.toISOString(),
  ].join("|");
}

// Compute v1 HMAC signature using Node crypto (mirrors the pre-migration code path).
function signV1(row: Parameters<typeof buildV1Input>[0]): string {
  // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — uses production config.hmacSecret, not a hardcoded key
  return createHmac("sha256", config.hmacSecret).update(buildV1Input(row)).digest("hex");
}

describe("audit chain — cross-era validation (pre/post @noble/hashes migration)", () => {
  let db: any;
  let client: any;
  let auditService: ReturnType<typeof createAuditService>;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;
    auditService = createAuditService(db);
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  // ---- Parity-reduction: import wiring check ----

  it("parity-reduction: hmacSha256(key, input) === Node createHmac on v1-style inputs", () => {
    const key = "test-hmac-secret-cross-era";

    // v1 format: action|actor|resource_type|resource_id|details_json|iso_date
    const inputs = [
      "review.created|agent:gwk_test|review||{}|2026-05-01T00:00:00.000Z",
      "review.decided|reviewer:a@b.com|review|rev_001|{\"decision\":\"approved\"}|2026-05-02T12:00:00.000Z",
      "user.login|system|reviewer|usr_001|{}|2026-05-03T08:30:00.000Z",
    ];

    for (const input of inputs) {
      // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — test-only fixed key; both sides must use identical key for parity assertion
      const nodeHex = createHmac("sha256", key).update(input).digest("hex");
      const nobleHex = hmacSha256(key, input);
      expect(nobleHex).toBe(nodeHex);
    }
  });

  it("parity-reduction: hmacSha256(key, input) === Node createHmac on v2-style inputs (with prev_signature)", () => {
    const key = "test-hmac-secret-cross-era";

    // v2 format: v2|prev_sig|action|actor|resource_type|resource_id|details_json|iso_date
    const prevSig = "a".repeat(64); // synthetic 64-char hex prev signature
    const inputs = [
      `v2|${prevSig}|review.created|agent:gwk_test|review||{}|2026-05-01T00:00:00.000Z`,
      `v2|${prevSig}|review.decided|reviewer:a@b.com|review|rev_001|{"decision":"approved"}|2026-05-02T12:00:00.000Z`,
    ];

    for (const input of inputs) {
      // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — test-only fixed key; both sides must use identical key for parity assertion
      const nodeHex = createHmac("sha256", key).update(input).digest("hex");
      const nobleHex = hmacSha256(key, input);
      expect(nobleHex).toBe(nodeHex);
    }
  });

  // ---- Cross-era integration: v1 rows + v2 rows in the same chain ----

  it("mixed v1+v2 chain: all rows validate via auditService.verify() (I3 load-bearing)", async () => {
    // Step 1: Insert 2 raw v1-format rows directly via db.insert with
    // Node-crypto-computed signatures. These simulate pre-migration rows already
    // on disk when Lane D deployed.
    const v1Row1 = {
      id: generateId("event"),
      action: "review.created" as AuditAction,
      actor: "agent:cross-era-v1",
      resource_type: "review",
      resource_id: "rev_cross_era_1",
      details: { source: "v1-direct-insert" },
      created_at: new Date("2026-05-01T10:00:00.000Z"),
      project_id: null as null,
      prev_signature: null as null,
      signature_version: 1 as const,
    };
    const v1Sig1 = signV1(v1Row1);

    const v1Row2 = {
      id: generateId("event"),
      action: "review.decided" as AuditAction,
      actor: "reviewer:cross-era@example.com",
      resource_type: "review",
      resource_id: "rev_cross_era_1",
      details: { decision: "approved" },
      created_at: new Date("2026-05-01T10:01:00.000Z"),
      project_id: null as null,
      prev_signature: null as null,
      signature_version: 1 as const,
    };
    const v1Sig2 = signV1(v1Row2);

    await db.insert(auditLog).values([
      { ...v1Row1, signature: v1Sig1 },
      { ...v1Row2, signature: v1Sig2 },
    ]);

    // Step 2: Insert 2 v2 rows via the migrated auditService.log() API.
    // These naturally chain from the last v1 row (cursor = v1Sig2).
    await auditService.log({
      action: "settings.changed" as AuditAction,
      actor: "system",
      resource_type: "reviewer",
    });
    await auditService.log({
      action: "auth.login_success" as AuditAction,
      actor: "reviewer:cross-era@example.com",
      resource_type: "session",
    });

    // Step 3: Verify the entire mixed-era chain.
    // HARD STOP: if any row returns valid=false, the migration broke on-disk row validation.
    const results = await auditService.verify(null);

    // Must include at least the 4 rows we inserted (may include rows from other tests
    // in the same partition if they ran first, but all must be valid).
    expect(results.length).toBeGreaterThanOrEqual(4);

    const v1Row1Result = results.find(r => r.row_id === v1Row1.id);
    const v1Row2Result = results.find(r => r.row_id === v1Row2.id);
    expect(v1Row1Result).toBeDefined();
    expect(v1Row2Result).toBeDefined();
    expect(v1Row1Result?.valid).toBe(true);
    expect(v1Row2Result?.valid).toBe(true);

    // Assert ALL rows in the partition are valid (including v2 rows from log()).
    for (const r of results) {
      expect(r.valid).toBe(true);
    }
  });
});

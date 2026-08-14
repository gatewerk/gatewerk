/**
 * Tests for the v2 HMAC chain on audit_log.
 *
 * Covers:
 *  1. Happy path: all rows verify cleanly.
 *  2. Deletion detection: deleting a mid-chain row triggers chain_break on
 *     its successor.
 *  3. Mutation detection: altering a row's details triggers signature_mismatch
 *     on that row; its successor still verifies (prev_signature is from the
 *     original stored signature, not the recomputed one).
 *  4. Concurrency: parallel log() calls for two projects both produce clean
 *     chains.
 *  5. Mixed v1+v2: a pre-inserted v1 row is verified with legacy logic; v2
 *     rows appended on top verify with chain logic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { createAuditService } from "../services/audit";
import { createTestDb } from "./helpers/test-db";
import { auditLog } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { config } from "../config";
import { eq, isNull } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function v1Signature(row: {
  action: string;
  actor: string;
  resource_type: string;
  resource_id?: string | null;
  details?: unknown;
  created_at: Date;
}): string {
  const input = [
    row.action,
    row.actor,
    row.resource_type,
    row.resource_id || "",
    JSON.stringify(row.details || {}),
    row.created_at.toISOString(),
  ].join("|");
  return createHmac("sha256", config.hmacSecret).update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function makeFixture() {
  const { db } = await createTestDb();
  const audit = createAuditService(db);
  return { db, audit };
}

// Unique project ids per test to avoid cross-test partition contamination.
let counter = 0;
function newProjectId(): string {
  return `proj_chain_test_${++counter}_${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("audit HMAC chain — v2", () => {
  describe("1. Happy path", () => {
    it("inserts N rows and verify returns all valid", async () => {
      const { db, audit } = await makeFixture();
      const projectId = newProjectId();

      for (let i = 0; i < 5; i++) {
        await audit.log({
          action: "review.created",
          actor: `agent:${i}`,
          resource_type: "review",
          resource_id: `res-${i}`,
          details: { seq: i },
          project_id: projectId,
        });
      }

      const results = await audit.verify(projectId);
      expect(results).toHaveLength(5);
      results.forEach((r) => {
        expect(r.valid).toBe(true);
        expect(r.reason).toBe("valid");
      });
    });
  });

  describe("2. Deletion detection", () => {
    it("deleting row N/2 causes chain_break on row N/2+1", async () => {
      const { db, audit } = await makeFixture();
      const projectId = newProjectId();
      const N = 6;
      const entries: { id: string }[] = [];

      for (let i = 0; i < N; i++) {
        const entry = await audit.log({
          action: "review.decided",
          actor: `reviewer:${i}`,
          resource_type: "review",
          resource_id: `del-res-${i}`,
          details: { seq: i },
          project_id: projectId,
        });
        entries.push({ id: entry.id });
      }

      // Delete the middle row (index N/2 = 3, 0-indexed).
      const deletedId = entries[Math.floor(N / 2)].id;
      await db.delete(auditLog).where(eq(auditLog.id, deletedId));

      const results = await audit.verify(projectId);

      // Should have N-1 results after the deletion.
      expect(results).toHaveLength(N - 1);

      // First half: valid.
      for (let i = 0; i < Math.floor(N / 2); i++) {
        expect(results[i].valid).toBe(true);
      }

      // The row immediately after the deleted one is now at index N/2 (since we
      // removed one). It should report chain_break because its stored
      // prev_signature references the deleted row's signature, which no longer
      // matches the preceding row.
      const breakRow = results[Math.floor(N / 2)];
      expect(breakRow.valid).toBe(false);
      expect(breakRow.reason).toBe("chain_break");
    });
  });

  describe("3. Mutation detection", () => {
    it("mutating row K details triggers signature_mismatch on K, row K+1 still valid", async () => {
      const { db, audit } = await makeFixture();
      const projectId = newProjectId();
      const N = 4;
      const entries: { id: string }[] = [];

      for (let i = 0; i < N; i++) {
        const entry = await audit.log({
          action: "template.updated",
          actor: "system",
          resource_type: "template",
          resource_id: `mut-res-${i}`,
          details: { seq: i },
          project_id: projectId,
        });
        entries.push({ id: entry.id });
      }

      // Mutate row at index 1 (K=1).
      const mutatedId = entries[1].id;
      await db
        .update(auditLog)
        .set({ details: { seq: 999, tampered: true } as any })
        .where(eq(auditLog.id, mutatedId));

      const results = await audit.verify(projectId);
      expect(results).toHaveLength(N);

      // Row 0: valid.
      expect(results[0].valid).toBe(true);

      // Row 1 (mutated): signature_mismatch — its recomputed signature won't
      // match because details changed.
      expect(results[1].valid).toBe(false);
      expect(results[1].reason).toBe("signature_mismatch");

      // Row 2: still valid — its stored prev_signature points to row 1's
      // ORIGINAL signature (which we didn't touch), and chain_break only fires
      // when prev_signature mismatches the preceding row's stored signature.
      // Since row 1's stored signature was NOT changed, the link holds.
      expect(results[2].valid).toBe(true);
      expect(results[2].reason).toBe("valid");

      // Row 3: valid.
      expect(results[3].valid).toBe(true);
    });
  });

  describe("4. Concurrency", () => {
    it("parallel log() for two projects both produce clean chains", async () => {
      const { audit } = await makeFixture();
      const projA = newProjectId();
      const projB = newProjectId();

      // Fire 8 log() calls for each project in parallel.
      const writes = Array.from({ length: 8 }, (_, i) =>
        Promise.all([
          audit.log({
            action: "review.created",
            actor: `agent:a${i}`,
            resource_type: "review",
            details: { seq: i },
            project_id: projA,
          }),
          audit.log({
            action: "review.created",
            actor: `agent:b${i}`,
            resource_type: "review",
            details: { seq: i },
            project_id: projB,
          }),
        ]),
      );

      await Promise.all(writes);

      const [resA, resB] = await Promise.all([
        audit.verify(projA),
        audit.verify(projB),
      ]);

      expect(resA).toHaveLength(8);
      resA.forEach((r) => expect(r.valid).toBe(true));

      expect(resB).toHaveLength(8);
      resB.forEach((r) => expect(r.valid).toBe(true));
    });
  });

  describe("5. Mixed v1 + v2", () => {
    it("verifies a pre-existing v1 row with legacy logic, then v2 rows with chain logic", async () => {
      const { db, audit } = await makeFixture();
      const projectId = newProjectId();

      // Pre-insert a v1 row directly (simulating a pre-migration row).
      const v1CreatedAt = new Date(Date.now() - 10_000); // 10 seconds ago
      const v1Row = {
        id: generateId("event"),
        action: "settings.changed" as const,
        actor: "system",
        resource_type: "project",
        resource_id: "legacy-res",
        details: { key: "v1-legacy" },
        project_id: projectId,
        created_at: v1CreatedAt,
      };
      const legacySignature = v1Signature(v1Row);

      await db.insert(auditLog).values({
        ...v1Row,
        signature: legacySignature,
        prev_signature: null,
        signature_version: 1,
      });

      // Append two v2 rows via audit.log().
      await audit.log({
        action: "review.created",
        actor: "agent:post-v1-a",
        resource_type: "review",
        details: { chain: "first_v2" },
        project_id: projectId,
      });

      await audit.log({
        action: "review.decided",
        actor: "agent:post-v1-b",
        resource_type: "review",
        details: { chain: "second_v2" },
        project_id: projectId,
      });

      const results = await audit.verify(projectId);
      expect(results).toHaveLength(3);

      // v1 row: verified with legacy logic.
      expect(results[0].valid).toBe(true);
      expect(results[0].reason).toBe("valid");

      // v2 rows: verified with chain logic.
      expect(results[1].valid).toBe(true);
      expect(results[1].reason).toBe("valid");

      expect(results[2].valid).toBe(true);
      expect(results[2].reason).toBe("valid");
    });
  });
});

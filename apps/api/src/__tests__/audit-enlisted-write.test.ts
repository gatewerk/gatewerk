/**
 * Tests for the SEALED tier of the audit-write contract — an audit row written
 * inside the caller's transaction, so the state change and its proof commit or
 * roll back as one unit.
 *
 * See apps/api/src/services/AUDIT-WRITE-CONTRACT.md.
 *
 * The load-bearing case is #3. An enlisted write must not advance the
 * in-memory partition chain, because the caller's transaction may still roll
 * back. If it did, every later write in that partition would chain onto a
 * prev_signature that no longer exists in the table, and verify() would report
 * chain_break on rows nobody touched — the audit chain would accuse itself of
 * tampering because of an ordinary rolled-back transaction.
 */

import { describe, it, expect } from "vitest";
import { createAuditService } from "../services/audit";
import { createTestDb } from "./helpers/test-db";
import { auditLog } from "@gatewerk/db/src/schema/index";
import { eq } from "drizzle-orm";

async function makeFixture() {
  const { db } = await createTestDb();
  const audit = createAuditService(db);
  return { db, audit };
}

let counter = 0;
function newProjectId(): string {
  return `proj_enlisted_${++counter}_${Date.now()}`;
}

describe("audit write — SEALED tier (enlisted in the caller's transaction)", () => {
  it("1. commits the audit row with the state change and verifies cleanly", async () => {
    const { db, audit } = await makeFixture();
    const projectId = newProjectId();

    await audit.log({
      action: "review.created",
      actor: "agent:seed",
      resource_type: "review",
      resource_id: "r-0",
      project_id: projectId,
    });

    await db.transaction(async (tx) => {
      await audit.log(
        {
          action: "review.decided",
          actor: "user:alice",
          resource_type: "review",
          resource_id: "r-1",
          details: { decision: "approved" },
          project_id: projectId,
        },
        { tx },
      );
    });

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.project_id, projectId));
    expect(rows).toHaveLength(2);

    const results = await audit.verify(projectId);
    expect(results).toHaveLength(2);
    results.forEach((r) => expect(r.valid).toBe(true));
  });

  it("2. returns the inserted row to the caller from inside the transaction", async () => {
    const { db, audit } = await makeFixture();
    const projectId = newProjectId();

    let seen: { id: string; action: string } | undefined;
    await db.transaction(async (tx) => {
      // The row is not visible outside this transaction yet, so log() must
      // read it back through the same handle.
      const entry = await audit.log(
        {
          action: "review.decided",
          actor: "user:bob",
          resource_type: "review",
          resource_id: "r-2",
          project_id: projectId,
        },
        { tx },
      );
      seen = entry as { id: string; action: string };
    });

    expect(seen).toBeDefined();
    expect(seen!.action).toBe("review.decided");
  });

  it("3. a rolled-back caller leaves no row AND does not corrupt the chain", async () => {
    const { db, audit } = await makeFixture();
    const projectId = newProjectId();

    await audit.log({
      action: "review.created",
      actor: "agent:seed",
      resource_type: "review",
      resource_id: "r-0",
      project_id: projectId,
    });

    // A state change whose audit row is sealed to it, which then fails.
    await expect(
      db.transaction(async (tx) => {
        await audit.log(
          {
            action: "review.decided",
            actor: "user:carol",
            resource_type: "review",
            resource_id: "r-doomed",
            project_id: projectId,
          },
          { tx },
        );
        throw new Error("state change failed after the audit write");
      }),
    ).rejects.toThrow("state change failed");

    // The audit row rolled back with it — no proof of a decision that did not
    // happen.
    const afterRollback = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.project_id, projectId));
    expect(afterRollback).toHaveLength(1);
    expect(afterRollback[0].resource_id).toBe("r-0");

    // The next write must chain onto the surviving tail, not onto the phantom
    // signature the rolled-back row would have left in the in-memory chain.
    await audit.log({
      action: "review.decided",
      actor: "user:dave",
      resource_type: "review",
      resource_id: "r-1",
      project_id: projectId,
    });

    const results = await audit.verify(projectId);
    expect(results).toHaveLength(2);
    results.forEach((r) => {
      expect(r.valid).toBe(true);
      expect(r.reason).toBe("valid");
    });
  });

  it("4. interleaved enlisted and self-contained writes all verify", async () => {
    const { db, audit } = await makeFixture();
    const projectId = newProjectId();

    for (let i = 0; i < 3; i++) {
      await audit.log({
        action: "review.created",
        actor: `agent:${i}`,
        resource_type: "review",
        resource_id: `plain-${i}`,
        details: { seq: i },
        project_id: projectId,
      });
      await db.transaction(async (tx) => {
        await audit.log(
          {
            action: "review.decided",
            actor: `user:${i}`,
            resource_type: "review",
            resource_id: `sealed-${i}`,
            details: { seq: i, nested: { b: 2, a: 1 } },
            project_id: projectId,
          },
          { tx },
        );
      });
    }

    const results = await audit.verify(projectId);
    expect(results).toHaveLength(6);
    results.forEach((r) => {
      expect(r.valid).toBe(true);
      expect(r.reason).toBe("valid");
    });
  });
});

describe("audit write — BEST_EFFORT tier", () => {
  it("reports the failure instead of swallowing it", async () => {
    const { db } = await makeFixture();
    const audit = createAuditService(db);

    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      // audit_log.actor is NOT NULL, so this write genuinely fails at the
      // database rather than being rejected in application code.
      audit.logBestEffort(
        {
          action: "review.created",
          actor: null as never,
          resource_type: "review",
        },
        "notification delivery must not fail on an audit outage",
      );
      // Let the rejection settle.
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      console.error = original;
    }

    expect(errors.length).toBeGreaterThan(0);
    const line = String(errors[0][0]);
    expect(line).toContain("[audit] best-effort write failed");
    expect(line).toContain("review.created");
    expect(line).toContain("notification delivery must not fail");
  });
});

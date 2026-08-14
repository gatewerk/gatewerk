import { eq, and, desc, gte, lte, sql, asc, isNull, inArray } from "drizzle-orm";
import { auditLog } from "@gatewerk/db/src/schema/index";
import { hmacSha256 } from "../lib/crypto";
import { config } from "../config";
import { generateId } from "@gatewerk/shared";
import type { AuditAction } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Legacy v1 signature input — must never change (backward compat). */
function v1Input(row: {
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

/**
 * Recursively sort object keys so a value serialises identically regardless
 * of the key order it happened to be constructed with.
 *
 * Arrays keep their order — array order is meaningful data, not incidental.
 * `undefined` values are dropped, matching both JSON.stringify and what a
 * JSONB round-trip does.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = sortKeysDeep(source[key]);
    }
    return out;
  }
  return value;
}

/** Order-independent serialisation of `details` for signing. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * v2 chain signature input.
 *
 * DEFECTIVE — retained only so existing v2 rows keep verifying under the
 * scheme they were written with. `JSON.stringify` emits keys in insertion
 * order, but verification re-serialises the row read back from a JSONB
 * column, whose key order Postgres normalises. Any v2 row whose `details`
 * carries two or more keys therefore recomputes to a different HMAC and
 * reports `signature_mismatch` even when nothing was tampered with.
 *
 * Never write new rows with this. Use v3Input.
 */
function v2Input(
  prevSignature: string,
  row: {
    action: string;
    actor: string;
    resource_type: string;
    resource_id?: string | null;
    details?: unknown;
    created_at: Date;
  },
): string {
  return [
    "v2",
    prevSignature,
    row.action,
    row.actor,
    row.resource_type,
    row.resource_id || "",
    JSON.stringify(row.details || {}),
    row.created_at.toISOString(),
  ].join("|");
}

/**
 * v3 chain signature input — identical to v2 except `details` is serialised
 * canonically, so a row signs and verifies to the same value regardless of
 * how Postgres orders the keys in the JSONB column.
 *
 * Introduced as a new version rather than a fix to v2 so historical rows keep
 * verifying under the scheme they were written with. Re-signing them would
 * have destroyed the tamper-evidence of everything already recorded. Same
 * approach the v1 → v2 migration took.
 */
function v3Input(
  prevSignature: string,
  row: {
    action: string;
    actor: string;
    resource_type: string;
    resource_id?: string | null;
    details?: unknown;
    created_at: Date;
  },
): string {
  return [
    "v3",
    prevSignature,
    row.action,
    row.actor,
    row.resource_type,
    row.resource_id || "",
    canonicalJson(row.details || {}),
    row.created_at.toISOString(),
  ].join("|");
}

/** Current signature version for newly written rows. */
const CURRENT_SIGNATURE_VERSION = 3;

/** Recompute the expected signature for a chain row at its own version. */
function chainSignatureFor(
  version: number,
  prevSignature: string,
  row: Parameters<typeof v3Input>[1],
): string {
  return version === 3
    ? hmacSign(v3Input(prevSignature, row))
    : hmacSign(v2Input(prevSignature, row));
}

function hmacSign(input: string): string {
  return hmacSha256(config.hmacSecret, input);
}

/**
 * Genesis anchor for a partition — the synthetic "previous signature" for the
 * very first v2 row in a project_id partition (or the system partition).
 */
function genesisSignature(projectId: string | null | undefined): string {
  const label = projectId ?? "system";
  return hmacSign(`genesis|${label}`);
}

/**
 * Deterministic bigint advisory lock key expression derived from the partition
 * label. pg_advisory_xact_lock takes bigint; hashtext() returns int4 (32-bit).
 * Casting int4 → bigint is safe and avoids any external hash dependency.
 */
function lockKeyExpr(projectId: string | null | undefined): string {
  const label = projectId ?? "system";
  return `hashtext('${label.replace(/'/g, "''")}:audit')::bigint`;
}

// ---------------------------------------------------------------------------
// Verify result type
// ---------------------------------------------------------------------------

export type ChainVerifyResult = {
  row_id: string;
  valid: boolean;
  reason: "valid" | "chain_break" | "signature_mismatch" | "missing_prev";
};

/**
 * A chain step returns the signature it wrote plus the value the in-memory
 * chain should carry forward.
 *
 * `nextPrev` is deliberately separate from `signature`. For a self-contained
 * write they are the same: the row is committed by the time we return, so the
 * next writer can chain onto it without a DB read. For a write enlisted in a
 * CALLER's transaction they are not: that transaction may still roll back, and
 * if the in-memory chain had advanced to a signature that no longer exists,
 * every subsequent write in the partition would chain onto a phantom row.
 * Enlisted writes therefore return `nextPrev: null`, which forces the next
 * writer to re-read the real tail from the database inside its own lock.
 */
type ChainStep = { signature: string; nextPrev: string | null };

type ChainFn = (inMemoryPrev: string | null) => Promise<ChainStep>;

/**
 * The transaction handle drizzle hands to a `db.transaction(cb)` callback.
 * Derived structurally so it tracks the AppDb type without importing drizzle
 * internals.
 */
export type AuditTx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

/** Fields every audit row carries, independent of how it is written. */
export type AuditWrite = {
  action: AuditAction;
  actor: string;
  resource_type: string;
  resource_id?: string;
  details?: Record<string, unknown>;
  // Cloud-readiness tenant isolation (B2, migration 026). Optional during
  // gradual rollout: routes/services that have a project_id in scope pass
  // it; the rest leave it null. Route filter on GET /api/v1/audit shows
  // NULL rows to admin sessions (less restrictive default). A future
  // hardening pass can require this and NOT-NULL the column.
  project_id?: string;
};

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export type AuditService = ReturnType<typeof createAuditService>;

export function createAuditService(db: AppDb) {
  // Per-partition JS chain. Carries the most-recently-written row's signature
  // as its resolved value so concurrent writes within the same process don't
  // need a DB round-trip to find prev_signature.
  //
  // CRITICAL: scoped to this service instance (and therefore to `db`). A
  // module-level Map would survive across pglite test DB lifetimes and
  // poison every subsequent test that reused a project_id — first write
  // would store a prev_signature that doesn't exist in the new DB. Each
  // createAuditService(db) call gets its own Map.
  //
  // Multi-process / cross-replica safety: pg_advisory_xact_lock inside each
  // transaction serializes writers across different processes. A fresh
  // replica has no in-memory state — it reads the DB on its first write
  // (inside the locked transaction) and builds its own chain from there.
  const partitionChain = new Map<string, Promise<string | null>>();

  function enqueueChainWrite(
    partitionKey: string,
    fn: ChainFn,
  ): Promise<string> {
    const existing = partitionChain.get(partitionKey);

    let next: Promise<ChainStep>;
    if (existing !== undefined) {
      next = existing.then(fn, () => fn(null));
    } else {
      next = fn(null);
    }

    // Non-rejecting tail: on failure we resolve to null so the next write
    // falls back to a DB read and the chain recovers gracefully. An enlisted
    // write resolves to null for the same reason — see ChainStep.
    partitionChain.set(partitionKey, next.then(
      (step) => step.nextPrev,
      () => null,
    ));

    return next.then((step) => step.signature);
  }

  return {
    /**
     * Insert a new audit log entry using the v2 chain scheme.
     *
     * The log() API surface is identical to the original — all callers
     * remain unchanged.
     */
    async log(data: AuditWrite, opts?: { tx?: AuditTx }) {
      const created_at = new Date();
      const projectId = data.project_id ?? null;
      const partitionKey = projectId ?? "system";
      const partitionFilter = projectId === null
        ? isNull(auditLog.project_id)
        : eq(auditLog.project_id, projectId);
      const enlisted = opts?.tx;

      /** Write the row on `handle`, which is either our own tx or the caller's. */
      const writeRow = async (
        handle: AuditTx,
        inMemoryPrev: string | null,
      ): Promise<string> => {
        // Acquire per-partition advisory transaction lock.
        // Cross-process serialization for multi-replica deployments.
        // Released automatically when the transaction commits / rolls back.
        // When enlisted, the lock is held for the whole of the caller's
        // transaction, so the state change and its proof become one unit.
        const lockExpr = lockKeyExpr(projectId);
        try {
          await handle.execute(sql.raw(`SELECT pg_advisory_xact_lock(${lockExpr})`));
        } catch {
          // Advisory lock unavailable — JS chain still serializes within-process.
        }

        // Prev signature resolution:
        // - In-memory (normal within-process path): use the signature threaded
        //   through the JS chain, guaranteed to be the immediately prior row's
        //   signature without any DB round-trip or timestamp ambiguity.
        // - DB path (first write from a fresh process / replica failover, and
        //   ALWAYS when enlisted): read the actual latest row inside the locked
        //   transaction so no concurrent replica can insert between our read
        //   and our insert. Enlisted writes never trust the in-memory value
        //   because the caller's transaction may already have rolled back
        //   rows that the in-memory chain still refers to.
        let prevSignature: string;
        if (inMemoryPrev !== null && !enlisted) {
          prevSignature = inMemoryPrev;
        } else {
          const [prev] = await handle
            .select({ signature: auditLog.signature })
            .from(auditLog)
            .where(partitionFilter)
            .orderBy(desc(auditLog.created_at), desc(auditLog.id))
            .limit(1);
          prevSignature = prev?.signature ?? genesisSignature(projectId);
        }

        const signature = hmacSign(v3Input(prevSignature, { ...data, created_at }));

        const [inserted] = await handle
          .insert(auditLog)
          .values({
            id: generateId("event"),
            action: data.action,
            actor: data.actor,
            resource_type: data.resource_type,
            resource_id: data.resource_id,
            details: data.details,
            signature,
            prev_signature: prevSignature,
            signature_version: CURRENT_SIGNATURE_VERSION,
            project_id: projectId,
            created_at,
          })
          .returning();

        return inserted.signature!;
      };

      // Phase 1: acquire the chain position and write the row. Both paths go
      // through the in-process queue so ordering within this process is
      // preserved regardless of which callers are enlisted.
      const rowSignature = await enqueueChainWrite(partitionKey, async (inMemoryPrev) => {
        if (enlisted) {
          const signature = await writeRow(enlisted, inMemoryPrev);
          // Do not advance the in-memory chain: the caller's transaction owns
          // this row's fate and may still roll it back. See ChainStep.
          return { signature, nextPrev: null };
        }
        const signature = await db.transaction((tx) => writeRow(tx, inMemoryPrev));
        return { signature, nextPrev: signature };
      });

      // Phase 2: retrieve the full inserted row for the caller. Enlisted reads
      // must use the caller's transaction — the row is not visible outside it
      // until that transaction commits.
      const reader = enlisted ?? db;
      const [entry] = await reader
        .select()
        .from(auditLog)
        .where(and(partitionFilter, eq(auditLog.signature, rowSignature)))
        .limit(1);

      return entry;
    },

    /**
     * Tier 3 of the audit-write contract — see
     * ./AUDIT-WRITE-CONTRACT.md.
     *
     * Records an event whose loss is acceptable because the state change is
     * independently durable and self-describing, and where an audit failure
     * must not fail the operation (a broken audit table must not stop an email
     * from sending). Failure is logged loudly rather than swallowed.
     *
     * This exists so a deliberate best-effort write is distinguishable from an
     * oversight. The old `.catch(() => {})` shape was identical for both, and
     * reported nothing when it fired. `reason` is required: it is the argument
     * for why losing this row is tolerable, recorded at the call site.
     */
    logBestEffort(data: AuditWrite, reason: string): void {
      void this.log(data).catch((err: unknown) => {
        console.error(
          `[audit] best-effort write failed action=${data.action} actor=${data.actor} ` +
          `resource=${data.resource_type}:${data.resource_id ?? "-"} reason="${reason}"`,
          err instanceof Error ? { name: err.name, message: err.message } : err,
        );
      });
    },

    /**
     * Verify every row in a project_id partition.
     *
     * v1 rows (signature_version = 1) are verified individually with the
     * original single-row HMAC. v2 rows (signature_version = 2) are verified
     * using pointer-based chain traversal: starting from the genesis anchor,
     * we follow prev_signature pointers forward rather than relying on
     * timestamp sort order. This is necessary because concurrent writes within
     * the same millisecond produce identical `created_at` values, making
     * sort-based ordering non-deterministic for the chain walk.
     *
     * Returns one result per row. Callers filter for !valid to detect tampering.
     */
    async verify(
      projectId: string | null | undefined,
    ): Promise<ChainVerifyResult[]> {
      const partitionFilter = (projectId == null)
        ? isNull(auditLog.project_id)
        : eq(auditLog.project_id, projectId);

      // Load all rows. We need all of them to build the chain graph.
      const allRows = await db
        .select()
        .from(auditLog)
        .where(partitionFilter)
        .orderBy(asc(auditLog.created_at), asc(auditLog.id));

      // Separate legacy (v1) and chain (v2) rows.
      // v1 rows are verified in arrival order (created_at, id sort is fine for
      // rows that were written sequentially under the old scheme).
      // v2 and v3 rows live in the SAME chain — after an upgrade, a v3 row's
      // prev_signature points at the last v2 row's signature — so they must be
      // traversed together, with the signature recomputed at each row's own
      // version. Splitting them would report chain_break at the boundary.
      const v1Rows = allRows.filter((r) => (r.signature_version ?? 1) === 1);
      const chainRows = allRows.filter((r) => {
        const v = r.signature_version ?? 1;
        return v === 2 || v === 3;
      });
      const unknownRows = allRows.filter((r) => {
        const v = r.signature_version ?? 1;
        return v !== 1 && v !== 2 && v !== 3;
      });

      // Results map keyed by row_id for final assembly.
      const resultMap = new Map<string, ChainVerifyResult>();

      // ---- v1 rows: individual HMAC verification ----
      for (const row of v1Rows) {
        const expected = hmacSign(v1Input(row));
        const valid = row.signature === expected;
        resultMap.set(row.id, {
          row_id: row.id,
          valid,
          reason: valid ? "valid" : "signature_mismatch",
        });
      }

      // ---- Unknown version rows ----
      for (const row of unknownRows) {
        resultMap.set(row.id, {
          row_id: row.id,
          valid: false,
          reason: "signature_mismatch",
        });
      }

      // ---- v2 rows: pointer-based chain traversal ----
      // Build a lookup: prevSignature → row (for forward traversal starting
      // from the genesis anchor).
      const byPrev = new Map<string, (typeof chainRows)[number]>();
      for (const row of chainRows) {
        if (row.prev_signature !== null && row.prev_signature !== undefined) {
          byPrev.set(row.prev_signature, row);
        } else {
          // v2 row with missing prev_signature.
          resultMap.set(row.id, {
            row_id: row.id,
            valid: false,
            reason: "missing_prev",
          });
        }
      }

      // The v2 chain starts at the last v1 row's signature (if any), or the
      // genesis anchor.
      const lastV1Sig = v1Rows.length > 0
        ? (v1Rows[v1Rows.length - 1].signature ?? null)
        : null;
      let cursor = lastV1Sig ?? genesisSignature(projectId);

      // Follow chain links forward; each visited row is valid if its stored
      // signature matches the recomputed v2 HMAC.
      const visited = new Set<string>();
      while (byPrev.has(cursor)) {
        const row = byPrev.get(cursor)!;
        if (visited.has(row.id)) break; // cycle guard (should never happen)
        visited.add(row.id);

        // Verify the stored prev_signature matches our cursor
        // (it always does by construction — we looked it up via byPrev).
        const storedPrev = row.prev_signature!;

        // Signature integrity check, at this row's own signature version.
        const expected = chainSignatureFor(row.signature_version ?? 2, storedPrev, row);
        const valid = row.signature === expected;
        resultMap.set(row.id, {
          row_id: row.id,
          valid,
          reason: valid ? "valid" : "signature_mismatch",
        });

        cursor = row.signature ?? "";
      }

      // Any chain rows NOT reachable from the genesis anchor are unreachable
      // chain segments — a deletion broke the path to them.
      for (const row of chainRows) {
        if (!resultMap.has(row.id)) {
          resultMap.set(row.id, {
            row_id: row.id,
            valid: false,
            reason: "chain_break",
          });
        }
      }

      // Return results in the original sort order (created_at, id) so callers
      // get a consistent, human-readable sequence.
      return allRows.map((r) => resultMap.get(r.id)!);
    },

    async query(filters?: {
      // A single action or several — the Activity pane's filter lets a
      // reviewer pick more than one action to match, so this takes both
      // shapes rather than forcing every one-action caller to wrap it.
      action?: string | string[];
      resource_type?: string;
      resource_id?: string;
      actor?: string;
      from?: Date;
      to?: Date;
      limit?: number;
      offset?: number;
      // Cloud-readiness tenant isolation (B2, migration 026). When set,
      // results are filtered to rows where audit_log.project_id = projectId
      // OR audit_log.project_id IS NULL. NULL-row visibility is intentional:
      // they are system-level rows that don't map to a project (or backfill
      // orphans), and the audit surface is admin-only — exposing them to all
      // admins is less restrictive than the alternative (hide from everyone).
      // Tightening to project-only can land in a follow-up hardening pass.
      project_id?: string;
    }) {
      const conditions: any[] = [];

      if (filters?.action) {
        const actions = Array.isArray(filters.action) ? filters.action : [filters.action];
        if (actions.length > 0) conditions.push(inArray(auditLog.action, actions));
      }
      if (filters?.resource_type)
        conditions.push(eq(auditLog.resource_type, filters.resource_type));
      if (filters?.resource_id)
        conditions.push(eq(auditLog.resource_id, filters.resource_id));
      if (filters?.actor) conditions.push(eq(auditLog.actor, filters.actor));
      if (filters?.from)
        conditions.push(gte(auditLog.created_at, filters.from));
      if (filters?.to) conditions.push(lte(auditLog.created_at, filters.to));
      if (filters?.project_id) {
        conditions.push(
          sql`(${auditLog.project_id} = ${filters.project_id} OR ${auditLog.project_id} IS NULL)`,
        );
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
      const limit = Math.min(filters?.limit || 50, 100);
      const offset = filters?.offset || 0;

      // Items + count run in parallel — same whereClause, no mutual dependency.
      const itemsPromise = db
        .select()
        .from(auditLog)
        .where(whereClause)
        .orderBy(desc(auditLog.created_at))
        .limit(limit + 1)
        .offset(offset);

      const countPromise = db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(auditLog)
        .where(whereClause);

      const [rows, countRows] = await Promise.all([itemsPromise, countPromise]);
      const count = countRows[0]?.count ?? 0;

      const has_more = rows.length > limit;
      const items = has_more ? rows.slice(0, limit) : rows;

      return { items, total: count, has_more };
    },
  };
}

import { eq, and, inArray } from "drizzle-orm";
import { reviews } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import { notInLiveChain } from "./_queries";

// Terminal-only, matching lifecycle.archive's `status IN ('decided','expired')`.
// Both slices previously guarded on `status <> 'monitoring'`
// alone, so the bulk paths and the single-review path disagreed on the
// invariant and the bulk ones were strictly more destructive: a live pending
// review — possibly with an external link out — could be archived out of every
// inbox or hard-DELETED, and `unarchive` derives the restored status from
// decided_at, so the round-trip landed it in the terminal `expired`.
//
// The severe case is a chain: archiving the review of an ACTIVE step strands
// the run permanently. chain-engine-reconcile.ts skips any review that is
// neither decided nor expired, and its orphan-halt branch requires
// `review_id IS NULL`, which archiving does not do — so the run stays 'active'
// with no reviewable review anywhere, with no audit row and no recovery short
// of manual SQL. bulkDelete NULLs review_id (ON DELETE SET NULL) and so at
// least halts visibly; archive is the silent one.
//
// The monitoring case is still covered: 'monitoring' is not terminal, so it
// remains excluded (spec §4.2) without needing its own clause.
const ARCHIVABLE_STATUSES = inArray(reviews.status, ["decided", "expired"]);

export function createReviewBulkSlice(db: AppDb) {
  return {
    async bulkArchive(
      projectId: string,
      ids: string[],
    ): Promise<{ count: number; archived_ids: string[] }> {
      if (ids.length === 0) return { count: 0, archived_ids: [] };
      const result = await db
        .update(reviews)
        .set({ status: "archived", updated_at: new Date() })
        .where(and(
          inArray(reviews.id, ids),
          eq(reviews.project_id, projectId),
          ARCHIVABLE_STATUSES,
          notInLiveChain(db),
        ))
        .returning({ id: reviews.id });
      // archived_ids lets the client's Undo target ONLY rows that actually
      // flipped — a mixed selection with skipped monitoring rows would
      // otherwise fan out unarchive calls that 4xx and report false failures.
      return { count: result.length, archived_ids: result.map((r) => r.id) };
    },

    async bulkDelete(
      projectId: string,
      ids: string[],
    ): Promise<{ count: number; deleted_ids: string[] }> {
      if (ids.length === 0) return { count: 0, deleted_ids: [] };
      const result = await db
        .delete(reviews)
        .where(and(
          inArray(reviews.id, ids),
          eq(reviews.project_id, projectId),
          ARCHIVABLE_STATUSES,
        ))
        .returning({ id: reviews.id });
      return { count: result.length, deleted_ids: result.map((r) => r.id) };
    },
  };
}

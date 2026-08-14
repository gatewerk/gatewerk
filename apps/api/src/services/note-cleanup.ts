import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  noteAttachments,
  reviews,
  templates,
  chainRuns,
} from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";

const TARGET_TABLES = {
  review: reviews,
  template: templates,
  chain_run: chainRuns,
} as const;

type TargetKind = keyof typeof TARGET_TABLES;

const GC_INTERVAL_MS_DEFAULT = 24 * 60 * 60 * 1000; // 24h per spec §11.7

/**
 * Cascade-delete a target row plus its polymorphic note_attachments rows
 * in a single transaction. Notes themselves are preserved — only the
 * attachment join rows are removed (notes outlive their attachments).
 *
 * Phase A spec §6.6 / AC #14: every target-deletion call site must route
 * through this helper so polymorphic FKs don't orphan in note_attachments.
 * The Task 23 GC worker is belt-and-suspenders for the (rare) path that
 * bypasses this helper; it is NOT load-bearing.
 */
export async function deleteWithNoteAttachments(
  db: AppDb,
  kind: TargetKind,
  id: string,
): Promise<void> {
  const table = TARGET_TABLES[kind];
  await db.transaction(async (tx) => {
    await tx
      .delete(noteAttachments)
      .where(and(
        eq(noteAttachments.target_kind, kind),
        eq(noteAttachments.target_id, id),
      ));
    await tx.delete(table).where(eq(table.id, id));
  });
}

/**
 * Sweep note_attachments for rows whose (target_kind, target_id) no longer
 * matches an existing target row. Three LEFT JOIN queries (one per kind)
 * collect orphan attachment ids, then a single inArray() delete clears them
 * in one round trip.
 *
 * Notes themselves are NEVER touched — only the polymorphic join rows.
 *
 * Phase A spec §11.7 / AC #15. Third defense layer for the cascade
 * contract — backstop for `services/reviews/bulk.ts:bulkDelete` (deliberately
 * bare per Task 21) plus any future delete site that bypasses
 * `deleteWithNoteAttachments`.
 */
export async function runOrphanGc(db: AppDb): Promise<number> {
  const orphanReviews = await db
    .select({ id: noteAttachments.id })
    .from(noteAttachments)
    .leftJoin(reviews, eq(reviews.id, noteAttachments.target_id))
    .where(and(
      eq(noteAttachments.target_kind, "review"),
      isNull(reviews.id),
    ));

  const orphanTemplates = await db
    .select({ id: noteAttachments.id })
    .from(noteAttachments)
    .leftJoin(templates, eq(templates.id, noteAttachments.target_id))
    .where(and(
      eq(noteAttachments.target_kind, "template"),
      isNull(templates.id),
    ));

  const orphanChains = await db
    .select({ id: noteAttachments.id })
    .from(noteAttachments)
    .leftJoin(chainRuns, eq(chainRuns.id, noteAttachments.target_id))
    .where(and(
      eq(noteAttachments.target_kind, "chain_run"),
      isNull(chainRuns.id),
    ));

  const orphanIds = [
    ...orphanReviews.map((r) => r.id),
    ...orphanTemplates.map((r) => r.id),
    ...orphanChains.map((r) => r.id),
  ];

  if (orphanIds.length === 0) return 0;

  await db
    .delete(noteAttachments)
    .where(inArray(noteAttachments.id, orphanIds));

  return orphanIds.length;
}

/**
 * Worker harness mirroring TimeoutWorker / WebhookRetryWorker /
 * ApiKeyUsageCleanup: setInterval-based tick, `start()` / `stop()` lifecycle,
 * `.catch()` on the tick promise so unhandled rejections don't crash the
 * host. Default 24h interval per spec §11.7. Idempotent — multiple `start()`
 * calls are no-ops.
 */
export class NoteCleanupWorker {
  private db: AppDb;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: { db: AppDb }) {
    this.db = deps.db;
  }

  start(intervalMs = GC_INTERVAL_MS_DEFAULT): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      runOrphanGc(this.db).catch((err) => {
        console.error("Note cleanup worker error:", err);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

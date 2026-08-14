import { eq, and, isNull, or, notInArray } from "drizzle-orm";
import { reviews, chainRuns } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";

// Companion to migration 073: normalize a raw JSONB field array into the canonical
// wire shape. Strips unknown keys; defaults editable to false. Called at
// review creation (snapshot capture) and on the read path (list/getById).
export function normalizeTemplateFields(raw: unknown): Array<{
  name: string; label: string; type: string; editable: boolean; options?: string[];
}> {
  const arr = (Array.isArray(raw) ? raw : []) as Array<{
    name: string; label: string; type: string; editable?: boolean; options?: string[];
  }>;
  return arr.map((f) => ({
    name: f.name,
    label: f.label,
    type: f.type,
    editable: f.editable === true,
    ...(f.options ? { options: f.options } : {}),
  }));
}

// Shared read primitive used by cross-slice callers (decide, retry, cancelRequest,
// updateVersion) that need to inspect current review state before a guarded UPDATE.
// Extracted from the `this.getById` pattern in the pre-decomposition monolith so
// each slice imports the helper instead of depending on composed-service shape.
export async function findReview(db: AppDb, projectId: string, id: string) {
  const [review] = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.id, id), eq(reviews.project_id, projectId)))
    .limit(1);
  return review || null;
}

/**
 * Not part of a LIVE chain run.
 *
 * The terminal-status guard on the archive paths closed the pending case but
 * leaves one open: a step's
 * review can be `decided` while its chain_steps row is still `active` — the
 * window before the engine advances, or permanently if the engine threw and
 * halted. `decided` passes the status guard, and archiving flips the status to
 * a value chain-engine-reconcile skips (it re-drives only decided|expired),
 * while review_id stays set so the orphan-halt branch never fires either. The
 * run is then active with no reviewable review anywhere, forever.
 *
 * Scoped to ACTIVE runs on purpose: once a run is completed / rejected /
 * aborted its reviews are ordinary history, and refusing to archive them would
 * make every chain review permanently unfileable.
 *
 * C1 raised the cost of getting this wrong. A chain step no longer sends
 * review.decided to the callback_url (charter §5.1), so a stranded run is now
 * silent on the wire as well as in the inbox.
 */
export function notInLiveChain(db: AppDb) {
  return or(
    isNull(reviews.chain_run_id),
    notInArray(
      reviews.chain_run_id,
      db.select({ id: chainRuns.id }).from(chainRuns).where(eq(chainRuns.status, "active")),
    ),
  );
}

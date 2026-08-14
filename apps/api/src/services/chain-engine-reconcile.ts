import { eq, and } from "drizzle-orm";
import { chainRuns, chainSteps, reviews } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import type { Priority } from "@gatewerk/shared";
import type { EventData } from "./events";

// Decisions onReviewDecided handles. Any other
// decided value would silently fall through and the step would remain 'active',
// re-driven on every sweep forever. Terminalize once instead.
const HANDLED_DECIDED = new Set<string>(["approved", "edited", "rejected"]);

// Crash-reconciliation sweep (lifecycle map §0/§11).
//
// The EventBus is in-process and fire-and-forget, so a crash between a
// review's terminal write and onReviewDecided/onReviewExpired strands the run
// in 'active'. This sweep finds active steps whose review is already terminal
// and re-drives the existing idempotent handlers with a synthetic event.
// Active steps with review_id NULL are logged + halted, never re-driven
// (re-materializing would double-create a review).
//
// Extracted from chain-engine.ts to keep that file under the 600-line hard cap
// (mirrors the pattern of chain-engine-abort.ts / chain-rejection.ts).

export interface ReconcileDeps {
  db: AppDb;
  /** Re-drive the decided handler (idempotent: carries its own atomic claim). */
  onReviewDecided: (data: EventData) => Promise<void>;
  /** Re-drive the expired handler (idempotent: carries its own atomic claim). */
  onReviewExpired: (data: EventData) => Promise<void>;
  /** Emit a step_halted audit for an orphan step (no review row). */
  haltOrphan: (data: EventData, err: unknown) => Promise<void>;
}

export async function reconcileImpl(
  deps: ReconcileDeps,
): Promise<{ redriven: number; halted: number }> {
  let redriven = 0;
  let halted = 0;

  // Find active steps under active runs. LEFT JOIN reviews so we also surface
  // orphan steps (review_id set but review row missing — treated as halted).
  const stranded = await deps.db
    .select({
      review_id: chainSteps.review_id,
      step_id: chainSteps.id,
      // chainRuns is INNER joined → project_id is always non-null; reliable
      // even when the review leftJoin produces no row (orphan case).
      run_project_id: chainRuns.project_id,
      review_status: reviews.status,
      decision: reviews.decision,
      template_slug: reviews.template_slug,
      priority: reviews.priority,
      review_created_at: reviews.created_at,
    })
    .from(chainSteps)
    .innerJoin(chainRuns, eq(chainSteps.chain_run_id, chainRuns.id))
    .leftJoin(reviews, eq(chainSteps.review_id, reviews.id))
    .where(
      and(
        eq(chainRuns.status, "active"),
        eq(chainSteps.status, "active"),
      ),
    );

  for (const row of stranded) {
    if (!row.review_id) {
      // Orphan class: step 'active' but review_id column is NULL — the step
      // was never fully materialized. Re-driving would double-create a review;
      // halt instead so operators can inspect via audit log.
      halted++;
      const orphanData: EventData = {
        review_id: row.step_id,
        template: "",
        project_id: row.run_project_id,
        priority: "normal",
        created_at: new Date().toISOString(),
      };
      await deps.haltOrphan(
        orphanData,
        new Error("reconcile: active chain step has no review row"),
      );
      // Terminalize once — prevents re-halt on every sweep (audit/webhook spam).
      await deps.db.update(chainSteps).set({ status: "skipped" })
        .where(and(eq(chainSteps.id, row.step_id), eq(chainSteps.status, "active")));
      continue;
    }

    const isDecided = row.review_status === "decided";
    const isExpired = row.review_status === "expired";
    if (!isDecided && !isExpired) continue; // review still live

    // Construct a minimal EventData sufficient for the idempotent handlers.
    // The handlers re-read the review from the DB; these fields are used for
    // error attribution (audit project_id, step_halted fallback) only.
    const synthetic: EventData = {
      review_id: row.review_id,
      template: row.template_slug ?? "",
      project_id: row.run_project_id,
      priority: ((row.priority ?? "normal") as Priority),
      created_at: (row.review_created_at ?? new Date()).toISOString(),
    };

    // Both handlers carry their own atomic claim (UPDATE WHERE status='active'
    // RETURNING), so duplicate delivery is harmless.
    if (isDecided) {
      // Defensive: a future/unknown decided value would silently fall through
      // onReviewDecided and leave the step 'active' — re-driven every sweep.
      // Terminalize once instead of looping.
      if (!HANDLED_DECIDED.has(row.decision ?? "")) {
        halted++;
        await deps.haltOrphan(synthetic, new Error(`reconcile: unhandled decided review decision '${row.decision}'`));
        await deps.db.update(chainSteps).set({ status: "skipped" })
          .where(and(eq(chainSteps.id, row.step_id), eq(chainSteps.status, "active")));
        continue;
      }
      await deps.onReviewDecided(synthetic);
    } else {
      await deps.onReviewExpired(synthetic);
    }
    redriven++;
  }

  if (redriven > 0 || halted > 0) {
    console.log(
      `Chain reconcile: re-drove ${redriven} stranded step(s), halted ${halted} orphan(s)`,
    );
  }

  return { redriven, halted };
}

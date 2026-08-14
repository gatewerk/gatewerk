import { eq, and, isNotNull, isNull, or, lt, lte, gt, inArray } from "drizzle-orm";
import { reviews } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import { ITERATION_STATUSES, type AssignmentLadder } from "@gatewerk/shared";
import { promoteLadder } from "./assignment-ladder";
import { WebhookService } from "./webhooks";
import { EventBus } from "./events";
import type { createAuditService } from "./audit";
import { resolveChainEventFields } from "../lib/chain-event-context";

// Assignment-ladder promotion, extracted from timeout-worker.ts to keep that
// file under the 600-line hard cap — the same reason chain-rejection.ts and
// chain-engine-token-resolution.ts were split out of chain-engine.ts, and
// mirroring the companion-module shape of timeout-worker-reminders.ts.
//
// Ladders are a distinct concern from timeouts: a timeout ends a review, a
// ladder hands the same still-open decision to the next person. The pure
// rung-walking logic already lives in assignment-ladder.ts; what follows is
// the claim / persist / audit / notify orchestration around it.

export interface LadderSweepDeps {
  db: AppDb;
  webhooks: WebhookService;
  eventBus: EventBus;
  auditService?: ReturnType<typeof createAuditService>;
  /** Injected rather than re-implemented so the worker keeps one lookup path. */
  getHmacSecret: (projectId: string) => Promise<string | null>;
}

/**
 * Claim and promote every review whose ladder is due.
 *
 * Invariants preserved from the original implementation:
 *   * expiry wins over promotion — a review already past `expires_at` is left
 *     to the timeout path rather than escalated to someone who cannot act.
 *   * snoozed reviews are skipped until the snooze elapses.
 *   * a 5-minute stale-claim window lets another worker retry after a crash.
 */
export async function sweepLadderPromotions(deps: LadderSweepDeps): Promise<number> {
  const now = new Date();
  const workerId = `worker-${process.pid}-${Date.now()}`;
  const claimTimeout = 5 * 60 * 1000; // 5 minutes

  const claimed = await deps.db
    .update(reviews)
    .set({
      claimed_by: workerId,
      claimed_at: now,
    })
    .where(
      and(
        inArray(reviews.status, ["pending", ...ITERATION_STATUSES]),
        isNotNull(reviews.ladder_next_promote_at),
        lte(reviews.ladder_next_promote_at, now),
        // Expiry wins over promotion.
        or(isNull(reviews.expires_at), gt(reviews.expires_at, now)),
        // Snooze guard: skip reviews whose snooze has not yet elapsed.
        or(isNull(reviews.snoozed_until), lte(reviews.snoozed_until, now)),
        or(
          isNull(reviews.claimed_by),
          lt(reviews.claimed_at, new Date(now.getTime() - claimTimeout)),
        ),
      ),
    )
    .returning();

  let processed = 0;
  for (const review of claimed) {
    try {
      await promoteOne(deps, review, workerId);
      processed++;
    } catch (err) {
      // Release claim on failure — mirrors `processExpired` failure path.
      await deps.db
        .update(reviews)
        .set({ claimed_by: null, claimed_at: null })
        .where(and(eq(reviews.id, review.id), eq(reviews.claimed_by, workerId)));
      console.error("Failed to promote ladder step", { reviewId: review.id, err });
    }
  }

  if (processed > 0) {
    console.log(`Timeout worker: promoted ${processed} ladder step(s)`);
  }

  return processed;
}

async function promoteOne(deps: LadderSweepDeps, review: any, workerId: string): Promise<void> {
  const safeWhere = and(eq(reviews.id, review.id), eq(reviews.claimed_by, workerId));

  const result = promoteLadder({
    ladder_index: review.ladder_index ?? 0,
    assignment_ladder: review.assignment_ladder as AssignmentLadder | null,
    created_at: review.created_at as Date,
  });

  const escalatedAt = new Date();

  const [updated] = await deps.db
    .update(reviews)
    .set({
      assignee: result.new_assignee,
      assignment_ladder: result.ladder,
      ladder_index: result.ladder_index,
      ladder_next_promote_at: result.ladder_next_promote_at,
      updated_at: escalatedAt,
      claimed_by: null,
      claimed_at: null,
    })
    .where(safeWhere)
    .returning();

  if (!updated) return; // Another worker processed it.

  // Audit entry. `actor: system:ladder` matches the spec §11 acceptance
  // criterion ("audit trail records promotion actor as `system:ladder`").
  if (deps.auditService) {
    await deps.auditService.log({
      action: "review.assignment_escalated",
      actor: "system:ladder",
      resource_type: "review",
      resource_id: review.id,
      details: {
        previous_assignee: result.previous_assignee,
        new_assignee: result.new_assignee,
        ladder_index: result.ladder_index,
      },
      // Without this the row lands in the NULL "system" partition, which
      // both excludes it from verify(projectId) and exposes it — including
      // the assignee identities above — to every tenant via the
      // `project_id IS NULL` clause in audit.query().
      project_id: review.project_id,
    }).catch((err) => console.error("Ladder audit log failed", { reviewId: review.id, err }));
  }

  // Webhook (only when the review carries a callback_url).
  if (review.callback_url) {
    const hmacSecret = await deps.getHmacSecret(review.project_id);
    if (hmacSecret !== null) {
      deps.webhooks.sendAssignmentEscalated({
        callback_url: review.callback_url,
        hmac_secret: hmacSecret,
        review_id: review.id,
        previous_assignee: result.previous_assignee,
        new_assignee: result.new_assignee,
        ladder_index: result.ladder_index,
        escalated_at: escalatedAt.toISOString(),
      }).catch((err) => console.error("Ladder escalation webhook failed", { reviewId: review.id, err }));
    }
  }

  // EventBus emit — SSE subscribers on the dashboard receive escalations
  // in real time. Same enriched payload shape as the webhook for
  // consumer symmetry. Chain-attached reviews thread chain context so
  // the dashboard can invalidate the chain queryKey if the escalation
  // belongs to an active chain.
  const escalatedChainCtx = review.chain_run_id
    ? await resolveChainEventFields(deps.db, review.chain_run_id, review.chain_step_id)
    : null;
  deps.eventBus.emit("review.assignment_escalated", {
    review_id: review.id,
    template: review.template_slug,
    project_id: review.project_id,
    priority: review.priority,
    created_at: review.created_at.toISOString(),
    previous_assignee: result.previous_assignee,
    new_assignee: result.new_assignee,
    ladder_index: result.ladder_index,
    escalated_at: escalatedAt.toISOString(),
    ...(escalatedChainCtx ?? {}),
  });
}

import { eq, and, lte, isNotNull, or, isNull, lt, gt, inArray, sql } from "drizzle-orm";
import { reviews, projects, reviewTokens, templates } from "@gatewerk/db/src/schema/index";
import { WebhookService } from "./webhooks";
import { EventBus } from "./events";
import type { createAuditService } from "./audit";
import { promoteLadder } from "./assignment-ladder";
import { ITERATION_STATUSES, type AssignmentLadder, type AuditAction } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import { resolveChainEventFields } from "../lib/chain-event-context";
import { sweepReminders } from "./timeout-worker-reminders";
import { sweepLadderPromotions } from "./timeout-worker-ladder";

export interface TimeoutWorkerDeps {
  db: AppDb;
  webhooks: WebhookService;
  eventBus: EventBus;
  // Optional so existing test callsites don't need to supply it. When
  // omitted, ladder promotions still happen but `review.assignment_escalated`
  // audit entries are skipped (prod wiring in app.ts always supplies one).
  auditService?: ReturnType<typeof createAuditService>;
}

export class TimeoutWorker {
  private db: AppDb;
  private webhooks: WebhookService;
  private eventBus: EventBus;
  private auditService: ReturnType<typeof createAuditService> | undefined;
  private interval: ReturnType<typeof setInterval> | null = null;

  /**
   * Liveness state, read by GET /health/ready. `lastTickAt` is stamped whether
   * the tick succeeded or threw, so a stale timestamp means the loop stopped
   * running and a non-null `lastTickError` means it is running but failing —
   * two different faults an operator needs to tell apart.
   */
  lastTickAt: Date | null = null;
  lastTickError: string | null = null;
  tickIntervalMs: number | null = null;

  constructor(deps: TimeoutWorkerDeps) {
    this.db = deps.db;
    this.webhooks = deps.webhooks;
    this.eventBus = deps.eventBus;
    this.auditService = deps.auditService;
  }

  /**
   * Start the worker loop. Each tick:
   *   1. `processExpired` — claims and transitions reviews past `expires_at`.
   *   2. `processLadderPromotions` — claims reviews whose assignment-ladder
   *      timer has elapsed and advances them to the next actor.
   *
   * Ordering is deliberate: expiry is a terminal transition (status →
   * decided|expired) and wins over ladder promotion when the same review is
   * due for both in the same tick. The ladder-claim predicate additionally
   * excludes rows whose `expires_at` has already elapsed, so even if the two
   * queries raced under concurrent dispatch the ladder claim could not
   * grab an about-to-be-expired row. See the comment block at the top of
   * `processLadderPromotions` for the invariant in full.
   */
  start(intervalMs = 30_000): void {
    this.tickIntervalMs = intervalMs;
    this.interval = setInterval(() => {
      void this.recordedTick("Timeout worker error:");
    }, intervalMs);

    // Run immediately on start
    void this.recordedTick("Timeout worker initial run error:");
  }

  /**
   * Run one tick and record the outcome so GET /health/ready can tell a stalled
   * or erroring worker from a healthy one. Previously a tick that threw every
   * time logged to console and nothing else — the review-timeout loop, which is
   * what makes "nothing hangs forever" true, could be dead indefinitely while
   * /health returned ok.
   */
  private async recordedTick(errorLabel: string): Promise<void> {
    try {
      await this.tick();
      this.lastTickAt = new Date();
      this.lastTickError = null;
    } catch (err) {
      this.lastTickAt = new Date();
      this.lastTickError = err instanceof Error ? err.message : String(err);
      console.error(errorLabel, err);
    }
  }

  async tick(): Promise<{ expired: number; promoted: number; reclaimed: number; maxIterations: number; confirmed: number; changeRequestsReverted: number; reminded: number }> {
    const expired = await this.processExpired();
    const reclaimed = await this.reclaimOrphanedExternalReviews();
    const promoted = await this.processLadderPromotions();
    const maxIterations = await this.processMaxIterations();
    const changeRequestsReverted = await this.processExpiredChangeRequests();
    const confirmed = await this.processMonitoringWindows();
    const reminded = await this.processReminders();
    return { expired, promoted, reclaimed, maxIterations, confirmed, changeRequestsReverted, reminded };
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Find and process all expired pending reviews.
   * Uses atomic claiming to prevent duplicate processing in multi-instance deployments.
   */
  async processExpired(): Promise<number> {
    const now = new Date();
    const workerId = `worker-${process.pid}-${Date.now()}`;
    const claimTimeout = 5 * 60 * 1000; // 5 minutes

    // Atomic claim: UPDATE ... WHERE claimed_by IS NULL (or stale) RETURNING
    const claimed = await this.db
      .update(reviews)
      .set({
        claimed_by: workerId,
        claimed_at: now,
      })
      .where(
        and(
          inArray(reviews.status, ["pending", "awaiting_external", ...ITERATION_STATUSES]),
          isNotNull(reviews.expires_at),
          lte(reviews.expires_at, now),
          // Snooze guard: skip reviews whose snooze has not yet elapsed.
          or(isNull(reviews.snoozed_until), lte(reviews.snoozed_until, now)),
          or(
            isNull(reviews.claimed_by),
            lt(reviews.claimed_at, new Date(now.getTime() - claimTimeout))
          ),
        ),
      )
      .returning();

    let processed = 0;

    for (const review of claimed) {
      try {
        await this.processOne(review, workerId);
        processed++;
      } catch (err) {
        // Release claim on failure
        await this.db
          .update(reviews)
          .set({ claimed_by: null, claimed_at: null })
          .where(and(eq(reviews.id, review.id), eq(reviews.claimed_by, workerId)));
        console.error("Failed to expire review", { reviewId: review.id, err });
      }
    }

    if (processed > 0) {
      console.log(`Timeout worker: processed ${processed} expired review(s)`);
    }

    return processed;
  }

  private async processOne(review: any, workerId: string): Promise<void> {
    const action = review.timeout_action || "expire";
    const safeWhere = and(eq(reviews.id, review.id), eq(reviews.claimed_by, workerId));

    if (action === "auto_approve" || action === "auto_reject") {
      const decision = action === "auto_approve" ? "approved" : "rejected";

      const [updated] = await this.db
        .update(reviews)
        .set({
          status: "decided",
          decision,
          decided_by: "system:timeout",
          decided_at: new Date(),
          approved_value: review.payload,
          updated_at: new Date(),
          claimed_by: null,
          claimed_at: null,
        })
        .where(safeWhere)
        .returning();

      if (!updated) return; // Another worker processed it

      // Proof before consequence: the audit row is written before the webhook
      // tells the agent to proceed, mirroring routes/account.ts:346. These are
      // the unattended transitions — no human was present, so the chain is the
      // only record that this review reached a terminal approved state and had
      // approved_value stamped.
      //
      // Awaited and NOT swallowed: a failure here is logged loudly rather than
      // discarded. This is not yet fail-closed — the state update above has
      // already committed, so throwing cannot undo the decision (and retrying
      // would re-fire the webhook). Making it atomic requires the audit write
      // to enlist in the same transaction as the state change; see the note on
      // createAuditService.log().
      await this.writeTimeoutAudit({
        action: action === "auto_approve" ? "review.auto_approved" : "review.auto_rejected",
        actor: "system:timeout",
        review,
        details: {
          decision,
          timeout_action: action,
          approved_value_stamped: true,
          iteration_count: review.current_version - 1,
        },
      });

      // Fire decision webhook
      const hmacSecret = await this.getHmacSecret(review.project_id);
      if (hmacSecret !== null) {
        this.webhooks.sendDecision({
          callback_url: review.callback_url,
          hmac_secret: hmacSecret,
          review_id: review.id,
          // C1 §5.1: a chain step's decision is never a review.decided on the
          // wire. Unreachable for chain steps today (materializeStep writes no
          // expires_at and no max_iterations, so neither claim query can see
          // one), and passed honestly so it stays correct if that changes.
          chain_run_id: review.chain_run_id ?? null,
          decision,
          decided_at: new Date().toISOString(),
          was_edited: false,
          // Derived: current_version - 1 at the point of auto-resolution.
          iteration_count: review.current_version - 1,
        }).catch((err) => console.error("Timeout webhook failed", { reviewId: review.id, err }));
      }

      // Chain context for chain-attached reviews so the dashboard can
      // invalidate the chain panel queryKey instead of polling.
      const decidedChainCtx = review.chain_run_id
        ? await resolveChainEventFields(this.db, review.chain_run_id, review.chain_step_id)
        : null;
      this.eventBus.emit("review.decided", {
        review_id: review.id,
        template: review.template_slug,
        project_id: review.project_id,
        priority: review.priority,
        created_at: review.created_at.toISOString(),
        decision,
        decided_at: new Date().toISOString(),
        ...(decidedChainCtx ?? {}),
      });
    } else {
      // Default: expire
      const [updated] = await this.db
        .update(reviews)
        .set({
          status: "expired",
          updated_at: new Date(),
          claimed_by: null,
          claimed_at: null,
        })
        .where(safeWhere)
        .returning();

      if (!updated) return; // Another worker processed it

      // `review.expired` was declared in AUDIT_ACTIONS but had zero emit sites
      // repo-wide before this.
      await this.writeTimeoutAudit({
        action: "review.expired",
        actor: "system:timeout",
        review,
        details: { timeout_action: action },
      });

      // Fire expiry webhook
      const hmacSecret = await this.getHmacSecret(review.project_id);
      if (hmacSecret !== null) {
        this.webhooks.sendExpiry({
          callback_url: review.callback_url,
          hmac_secret: hmacSecret,
          review_id: review.id,
          timeout_action: action,
          expired_at: new Date().toISOString(),
        }).catch((err) => console.error("Expiry webhook failed", { reviewId: review.id, err }));
      }

      const expiredChainCtx = review.chain_run_id
        ? await resolveChainEventFields(this.db, review.chain_run_id, review.chain_step_id)
        : null;
      this.eventBus.emit("review.expired", {
        review_id: review.id,
        template: review.template_slug,
        project_id: review.project_id,
        priority: review.priority,
        created_at: review.created_at.toISOString(),
        expired_at: new Date().toISOString(),
        timeout_action: action,
        ...(expiredChainCtx ?? {}),
      });
    }
  }

  /**
   * Audit a timeout-driven terminal outcome.
   *
   * Always passes `project_id`, so the row lands in the review's own chain
   * partition rather than the shared `NULL` system partition — a row without
   * it is both invisible to `verify(projectId)` and visible cross-tenant
   * through the `project_id IS NULL` clause in audit.query().
   *
   * Failure is logged, never swallowed: an unaudited unattended decision is
   * exactly the case the chain exists for, so it must be noisy.
   */
  private async writeTimeoutAudit(args: {
    action: AuditAction;
    actor: string;
    review: any;
    details: Record<string, unknown>;
  }): Promise<void> {
    if (!this.auditService) return;
    try {
      await this.auditService.log({
        action: args.action,
        actor: args.actor,
        resource_type: "review",
        resource_id: args.review.id,
        details: args.details,
        project_id: args.review.project_id,
      });
    } catch (err) {
      console.error("Timeout audit log failed — unattended decision is unproven", {
        reviewId: args.review.id,
        projectId: args.review.project_id,
        action: args.action,
        err,
      });
    }
  }

  private async getHmacSecret(projectId: string): Promise<string | null> {
    const [proj] = await this.db
      .select({ hmac_secret: projects.hmac_secret })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!proj) {
      // Race: project deleted while the timeout worker held a stale review row.
      // Do not fall back to env-level secret — removed deliberately; a
      // shared fallback secret defeats per-project HMAC isolation.
      console.error("Timeout worker: project not found during HMAC lookup", { projectId });
      return null;
    }
    return proj.hmac_secret;
  }

  /**
   * Close awaiting_iteration reviews that have exceeded their max_iterations
   * cap. A review "hits the cap" when current_version - 1 >= max_iterations
   * (i.e., the agent has already seen max_iterations feedback rounds with no
   * resolution). The review is closed as decided / max_iterations_reached.
   * callback_url is null-checked before firing sendDecision.
   */
  async processMaxIterations(): Promise<number> {
    const now = new Date();

    // Claim all awaiting_iteration rows where current_version - 1 >= max_iterations.
    // Uses a raw SQL predicate for the arithmetic — Drizzle ORM doesn't have a
    // column-vs-column comparison helper.
    const claimed = await this.db
      .update(reviews)
      .set({ claimed_by: `worker-${process.pid}-${Date.now()}`, claimed_at: now })
      .where(
        and(
          inArray(reviews.status, [...ITERATION_STATUSES]),
          isNotNull(reviews.max_iterations),
          // current_version - 1 >= max_iterations ⟺ current_version > max_iterations
          sql`${reviews.current_version} > ${reviews.max_iterations}`,
          or(
            isNull(reviews.claimed_by),
            lt(reviews.claimed_at, new Date(now.getTime() - 5 * 60 * 1000)),
          ),
        ),
      )
      .returning();

    let processed = 0;

    for (const review of claimed) {
      try {
        await this.closeMaxIterations(review);
        processed++;
      } catch (err) {
        await this.db
          .update(reviews)
          .set({ claimed_by: null, claimed_at: null })
          .where(eq(reviews.id, review.id));
        console.error("Failed to close max-iterations review", { reviewId: review.id, err });
      }
    }

    if (processed > 0) {
      console.log(`Timeout worker: closed ${processed} max-iterations review(s)`);
    }

    return processed;
  }

  private async closeMaxIterations(review: any): Promise<void> {
    const decidedAt = new Date();
    const decision = "max_iterations_reached";

    // Atomic terminal write: re-check the close is STILL warranted at write
    // time. Between claim and here, the agent's iteration-submit path
    // (submitNewVersion, a FOR UPDATE tx) may have committed a new version —
    // flipping status back to `pending` and bumping current_version past the
    // claim snapshot. Re-asserting `status IN ITERATION_STATUSES` AND
    // `current_version > max_iterations` in the WHERE means a concurrently
    // re-submitted review yields 0 rows → no clobber, no stale webhook. This
    // mirrors the `safeWhere` guard on the sibling `processOne` timeout path.
    const [updated] = await this.db
      .update(reviews)
      .set({
        status: "decided",
        decision,
        decided_by: "system:max_iterations",
        decided_at: decidedAt,
        updated_at: decidedAt,
        claimed_by: null,
        claimed_at: null,
      })
      .where(
        and(
          eq(reviews.id, review.id),
          inArray(reviews.status, [...ITERATION_STATUSES]),
          sql`${reviews.current_version} > ${reviews.max_iterations}`,
        ),
      )
      .returning();

    if (!updated) return; // Concurrently re-submitted (now pending) or already processed

    // Terminal close with no human present — same accountability gap as the
    // processOne timeout paths.
    await this.writeTimeoutAudit({
      action: "review.max_iterations_reached",
      actor: "system:max_iterations",
      review,
      details: {
        decision,
        current_version: review.current_version,
        max_iterations: review.max_iterations,
      },
    });

    // Only fire webhook when callback_url is present
    if (review.callback_url) {
      const hmacSecret = await this.getHmacSecret(review.project_id);
      if (hmacSecret !== null) {
        this.webhooks.sendDecision({
          callback_url: review.callback_url,
          hmac_secret: hmacSecret,
          review_id: review.id,
          // C1 §5.1: a chain step's decision is never a review.decided on the
          // wire. Unreachable for chain steps today (materializeStep writes no
          // expires_at and no max_iterations, so neither claim query can see
          // one), and passed honestly so it stays correct if that changes.
          chain_run_id: review.chain_run_id ?? null,
          decision,
          decided_at: decidedAt.toISOString(),
          was_edited: false,
          iteration_count: review.current_version - 1,
        }).catch((err) => console.error("Max-iterations webhook failed", { reviewId: review.id, err }));
      }
    }

    const chainCtx = review.chain_run_id
      ? await resolveChainEventFields(this.db, review.chain_run_id, review.chain_step_id)
      : null;
    this.eventBus.emit("review.decided", {
      review_id: review.id,
      template: review.template_slug,
      project_id: review.project_id,
      priority: review.priority,
      created_at: review.created_at instanceof Date
        ? review.created_at.toISOString()
        : String(review.created_at),
      decision,
      decided_at: decidedAt.toISOString(),
      ...(chainCtx ?? {}),
    });
  }

  /** Auto-revert stale awaiting_iteration reviews to pending when the
   *  template's changes_timeout_hours has elapsed. Moved from the GET /reviews
   *  opportunistic path (lifecycle map §0.3): the worker is the single owner
   *  so the revert fires even when no one opens the dashboard.
   *
   *  Single UPDATE ... WHERE EXISTS (correlated subquery) RETURNING — DB-clock
   *  authoritative, same structural pattern as reclaimOrphanedExternalReviews. */
  async processExpiredChangeRequests(): Promise<number> {
    const rows = await this.db
      .update(reviews)
      .set({ status: "pending", updated_at: new Date() })
      .where(
        and(
          inArray(reviews.status, [...ITERATION_STATUSES]),
          sql`EXISTS (
            SELECT 1 FROM ${templates}
            WHERE ${templates.slug} = ${reviews.template_slug}
              AND ${templates.project_id} = ${reviews.project_id}
              AND ${templates.changes_timeout_hours} IS NOT NULL
              AND ${reviews.updated_at} < NOW() - (${templates.changes_timeout_hours} * INTERVAL '1 hour')
          )`,
        ),
      )
      .returning({
        id: reviews.id,
        project_id: reviews.project_id,
        template_slug: reviews.template_slug,
        priority: reviews.priority,
        created_at: reviews.created_at,
      });

    for (const row of rows) {
      this.eventBus.emit("review.retried", {
        review_id: row.id,
        template: row.template_slug,
        project_id: row.project_id,
        priority: row.priority as import("@gatewerk/shared").Priority,
        created_at: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
      });

      if (this.auditService) {
        await this.auditService.log({
          action: "review.changes_timeout_reverted",
          actor: "system:changes_timeout",
          resource_type: "review",
          resource_id: row.id,
          details: { reason: "changes_timeout_elapsed" },
          project_id: row.project_id,
        });
      }
    }

    if (rows.length > 0) {
      console.log(`Timeout worker: reverted ${rows.length} stale change-request review(s) to pending`);
    }
    return rows.length;
  }

  /**
   * HOTL monitoring gate: silence means
   * all-clear. Claims monitoring reviews whose expires_at has elapsed and
   * auto-confirms them with decided_by 'system:monitoring_window' +
   * lapsed:true — a lapse is absence of objection, NEVER presented as human
   * sign-off. Deliberately NO snooze guard: monitoring reviews cannot be
   * snoozed (write-side 4xx lands in the guards task), and honoring a
   * directly-written snoozed_until here would silently suppress the
   * auto-confirm contract.
   */
  async processMonitoringWindows(): Promise<number> {
    const now = new Date();
    const workerId = `worker-${process.pid}-${Date.now()}`;
    const claimTimeout = 5 * 60 * 1000; // 5 minutes

    const claimed = await this.db
      .update(reviews)
      .set({ claimed_by: workerId, claimed_at: now })
      .where(
        and(
          eq(reviews.status, "monitoring"),
          isNotNull(reviews.expires_at),
          // Boundary judged on the DB clock, same domain as the human CAS
          // (spec §4.2 server-authoritative). App-clock skew must never let
          // the worker confirm before the authoritative window close.
          sql`${reviews.expires_at} <= NOW()`,
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
        await this.confirmOne(review, workerId);
        processed++;
      } catch (err) {
        await this.db
          .update(reviews)
          .set({ claimed_by: null, claimed_at: null })
          .where(and(eq(reviews.id, review.id), eq(reviews.claimed_by, workerId)));
        console.error("Failed to auto-confirm monitoring review", { reviewId: review.id, err });
      }
    }
    if (processed > 0) {
      console.log(`Timeout worker: auto-confirmed ${processed} monitoring review(s)`);
    }
    return processed;
  }

  private async confirmOne(review: any, workerId: string): Promise<void> {
    const decidedAt = new Date();

    // Exactly-once terminal CAS (spec §4.3): re-assert status='monitoring'
    // at write time. A human veto/confirm committed between claim and here
    // flipped status to 'decided' (and cleared claimed_by) → zero rows →
    // no clobber, no contradictory webhook. Mirrors closeMaxIterations,
    // NOT processOne (whose (id, claimed_by)-only WHERE is exactly the
    // veto-clobber race this feature must not reopen).
    //
    // decided_at = expires_at, NOT wall clock: the lapse happened when the
    // window closed; the write is materialization. After expires_at no human
    // decision can commit, so the outcome was determined AT the boundary —
    // stamping write time would drift 30s+ (unbounded after worker downtime)
    // and pollute response-time stats. updated_at + audit stay at wall clock.
    const [updated] = await this.db
      .update(reviews)
      .set({
        status: "decided",
        decision: "confirmed",
        decided_by: "system:monitoring_window",
        decided_at: review.expires_at,
        updated_at: decidedAt,
        claimed_by: null,
        claimed_at: null,
      })
      .where(
        and(
          eq(reviews.id, review.id),
          eq(reviews.claimed_by, workerId),
          eq(reviews.status, "monitoring"),
        ),
      )
      .returning();

    if (!updated) return; // Human decided in the race window — they win.

    // Side effects build from `updated` (the RETURNING row), not the stale
    // claim snapshot — same convention as the veto/confirm endpoints.
    const confirmedAt = updated.expires_at instanceof Date
      ? updated.expires_at.toISOString()
      : String(updated.expires_at);

    if (this.auditService) {
      await this.auditService.log({
        action: "review.confirmed",
        actor: "system:monitoring_window",
        resource_type: "review",
        resource_id: updated.id,
        details: { lapsed: true },
        project_id: updated.project_id,
      }).catch((err) => console.error("Monitoring confirm audit failed", { reviewId: updated.id, err }));
    }

    if (updated.callback_url) {
      const hmacSecret = await this.getHmacSecret(updated.project_id);
      if (hmacSecret !== null) {
        this.webhooks.sendConfirmed({
          callback_url: updated.callback_url,
          hmac_secret: hmacSecret,
          review_id: updated.id,
          confirmed_at: confirmedAt,
          decided_by: "system:monitoring_window",
          lapsed: true,
        }).catch((err) => console.error("Monitoring confirm webhook failed", { reviewId: updated.id, err }));
      }
    }

    this.eventBus.emit("review.confirmed", {
      review_id: updated.id,
      template: updated.template_slug,
      project_id: updated.project_id,
      priority: updated.priority as import("@gatewerk/shared").Priority,
      created_at: updated.created_at instanceof Date
        ? updated.created_at.toISOString()
        : String(updated.created_at),
      confirmed_at: confirmedAt,
      decided_by: "system:monitoring_window",
      lapsed: true,
    });
  }

  /**
   * Claim and promote reviews whose assignment-ladder timer has elapsed.
   *
   * Claim predicate carries three invariants worth stating explicitly:
   *   1. `status IN (pending, changes_requested)` — terminal states
   *      (decided, expired, archived) never promote.
   *   2. `expires_at IS NULL OR expires_at > NOW()` — an about-to-expire
   *      review is always owned by `processExpired`. This is the second
   *      half of the "expiry wins over promotion" invariant documented at
   *      the top of `start()`; the first half is that `tick()` runs
   *      expiry before ladder in every invocation.
   *   3. `claimed_by IS NULL OR claimed_at < stale` — the standard atomic
   *      claim pattern, identical to `processExpired`, so multi-instance
   *      deploys can't double-promote the same review.
   */
  /**
   * Assignment-ladder promotion. The claim / persist / audit / notify
   * orchestration lives in `sweepLadderPromotions` (companion module), the
   * same split as `sweepReminders` — ladders are a distinct concern from
   * timeouts, and the file has a 600-line cap.
   */
  async processLadderPromotions(): Promise<number> {
    return sweepLadderPromotions({
      db: this.db,
      webhooks: this.webhooks,
      eventBus: this.eventBus,
      auditService: this.auditService,
      getHmacSecret: (projectId) => this.getHmacSecret(projectId),
    });
  }

  /**
   * Reclaim reviews stuck in awaiting_external with no active token.
   * A review is "orphaned" when all its tokens are revoked, consumed, or expired.
   * Reverts to pending so the reviewer can take action.
   */
  async reclaimOrphanedExternalReviews(): Promise<number> {
    // Use Drizzle's typed query builder to avoid the driver-shape mismatch:
    // postgres.js returns rows directly; pglite returns { rows, rowCount, ... }.
    // The .update().returning() API is driver-agnostic — rows is always the result.
    const rows = await this.db
      .update(reviews)
      .set({ status: "pending", updated_at: new Date() })
      .where(
        and(
          eq(reviews.status, "awaiting_external"),
          sql`NOT EXISTS (
            SELECT 1 FROM ${reviewTokens}
            WHERE ${reviewTokens.review_id} = ${reviews.id}
              AND ${reviewTokens.used_at} IS NULL
              AND ${reviewTokens.revoked_at} IS NULL
              AND ${reviewTokens.is_preview} = false
              AND (${reviewTokens.expires_at} IS NULL OR ${reviewTokens.expires_at} > NOW())
          )`,
        ),
      )
      .returning({
        id: reviews.id,
        project_id: reviews.project_id,
        template_slug: reviews.template_slug,
        priority: reviews.priority,
        created_at: reviews.created_at,
      });

    for (const row of rows) {
      this.eventBus.emit("review.retried", {
        review_id: row.id,
        template: row.template_slug,
        project_id: row.project_id,
        priority: row.priority as import("@gatewerk/shared").Priority,
        created_at: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
      });

      if (this.auditService) {
        await this.auditService.log({
          action: "review.reclaimed",
          actor: "system:timeout",
          resource_type: "review",
          resource_id: row.id,
          details: { reason: "no_active_token" },
          project_id: row.project_id,
        });
      }
    }

    if (rows.length > 0) {
      console.log(`Timeout worker: reclaimed ${rows.length} orphaned external review(s)`);
    }

    return rows.length;
  }

  /**
   * Reminder sweep (one nudge at 75% of the timeout window). Thin delegator —
   * the atomic UPDATE + emit logic lives in `sweepReminders` (companion module)
   * to keep this file under the modular line cap.
   */
  async processReminders(): Promise<number> {
    return sweepReminders(this.db, this.eventBus);
  }
}

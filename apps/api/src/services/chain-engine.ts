import { eq, and } from "drizzle-orm";
import {
  chainRuns,
  chainSteps,
  reviews,
  projects,
  templates,
  reviewers,
} from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import {
  generateId,
  InvalidRequestError,
  type ChainDefinition,
  type ChainDefinitionStep,
  type AssigneeSpec,
  type Priority,
} from "@gatewerk/shared";
import { normalizeTemplateFields } from "./reviews/_queries";
import { WebhookService } from "./webhooks";
import type { EventBus, EventData } from "./events";
import type { createAuditService } from "./audit";
import { createReviewTokenService } from "./review-tokens";
import {
  resolveChainTokenInputs,
  scrubAssigneeSpecPii,
} from "./chain-engine-token-resolution";
import { applyStepRejection } from "./chain-rejection";
import { chainOwnerEmail } from "./chain-engine-owner";
import {
  abortRunImpl,
  emitStepHalted,
  chainRunStillActive,
  flipStepActiveGuarded,
  buildTranscriptImpl,
} from "./chain-engine-abort";
import { reconcileImpl } from "./chain-engine-reconcile";
import {
  loadChainStepCounts,
  chainEventFieldsFromCache,
} from "../lib/chain-event-context";
import { assertSmtpForExternalTokenSteps } from "./chain-engine-smtp-guard";
import {
  resolveEntryTemplateSlug,
  loadEntryTemplate,
  entryTemplateSlugForRun,
} from "./chain-engine-entry-template";

export interface ChainEngineDeps {
  db: AppDb;
  webhooks: WebhookService;
  eventBus: EventBus;
  auditService?: ReturnType<typeof createAuditService>;
  // isEmailConfigured lives on the constructor signature intersection (not exported via this
  // interface) because ChainEngineDeps is consumed by external modules (chain routes, tests)
  // that should not carry the SMTP predicate as a required concern.
}

export interface CreateRunInput {
  definition: ChainDefinition;
  initial_payload: Record<string, unknown>;
  callback_url?: string;
  metadata?: Record<string, unknown>;
  project_id: string;
  created_by: string;
  /**
   * C1: the entry template, when the caller already knows it. POST /reviews
   * resolves the template the chain_config hangs off, so it passes it here
   * rather than making the definition repeat itself.
   */
  entry_template_slug?: string;
}

export interface CreateRunResult {
  chain_run_id: string;
  step_1_review_id: string;
  status: "active";
}

type ReviewRow = typeof reviews.$inferSelect;
type ChainRunRow = typeof chainRuns.$inferSelect;
type ChainStepRow = typeof chainSteps.$inferSelect;

// ChainEngine — sequential chain materialisation (M10 Phase 1, M13 per-step
// rejection policies).
//
// Lifecycle:
//   * createRun:       insert chain_runs + chain_steps rows + materialise step 1.
//   * onReviewDecided: on approval → advance to next step (or complete);
//                      on rejection → delegate to `applyStepRejection`
//                      (chain-rejection.ts) which dispatches abort / continue /
//                      branch based on the step's `rejection_policy`.
//                      When rejection_policy is NULL the dispatcher defaults
//                      to 'abort' (pre-M13 backward compatibility).
//
// Concurrency: unlike TimeoutWorker the engine does not atomic-claim — it
// reacts to EventBus `review.decided` emissions and applies per-decision
// updates. Bounded by the single-writer emit loop. Multi-instance deployments
// will need the claim pattern TimeoutWorker uses (M9 handoff note).
export class ChainEngine {
  private db: AppDb;
  private webhooks: WebhookService;
  private auditService: ReturnType<typeof createAuditService> | undefined;
  private tokenService: ReturnType<typeof createReviewTokenService>;
  // Held so internal materialisation paths (handleApprove → step N+1,
  // chain-rejection continue/branch re-materialisation) can emit the
  // SSE-visible review.created/review.urgent events for the new review,
  // mirroring the route-layer emit at POST /chain-runs (chains.ts:97-99)
  // and POST /reviews (crud.ts:142-154). Step 1 is still emitted at the
  // route layer; this engine emit fires only for step 2+ to avoid double
  // emission.
  private eventBus: EventBus;
  private isEmailConfigured: (() => boolean) | undefined;

  constructor(deps: ChainEngineDeps & { isEmailConfigured?: () => boolean }) {
    this.db = deps.db;
    this.webhooks = deps.webhooks;
    this.auditService = deps.auditService;
    this.tokenService = createReviewTokenService(deps.db);
    this.eventBus = deps.eventBus;
    this.isEmailConfigured = deps.isEmailConfigured;
  }

  /**
   * Subscribe to EventBus so decided chain-attached reviews advance the
   * chain. Must be called once during app wiring (after EventBus is created
   * but before routes accept traffic). Returns no unsubscribe hook — the
   * engine lives for the app lifetime.
   */
  subscribe(eventBus: EventBus): void {
    eventBus.on("review.decided", (data) => this.onReviewDecided(data));
    eventBus.on("review.expired", (data) => this.onReviewExpired(data));
  }

  // --- Read API -----------------------------------------------------------
  //
  // Both reads are project-scoped at the engine layer — callers must
  // resolve a projectId (mirror the `resolveProjectId` pattern from
  // `routes/stats.ts`) before invoking. Skipping the filter is benign on
  // OSS single-project but a cross-tenant read on cloud (multi-project).

  async getRun(runId: string, projectId: string) {
    const [run] = await this.db
      .select()
      .from(chainRuns)
      .where(and(eq(chainRuns.id, runId), eq(chainRuns.project_id, projectId)))
      .limit(1);
    if (!run) return null;

    const steps = await this.db
      .select()
      .from(chainSteps)
      .where(eq(chainSteps.chain_run_id, runId))
      .orderBy(chainSteps.step_number);

    return { run, steps };
  }

  async getChainContextForReview(reviewId: string, projectId: string) {
    const [review] = await this.db
      .select()
      .from(reviews)
      .where(and(eq(reviews.id, reviewId), eq(reviews.project_id, projectId)))
      .limit(1);
    if (!review || !review.chain_run_id) return null;

    return this.getRun(review.chain_run_id, projectId);
  }

  async abortRun(runId: string, projectId: string, actor: string): Promise<{ status: "aborted"; skipped: number } | null> {
    return abortRunImpl(this.engineDeps(), runId, projectId, actor);
  }

  // --- Write API ----------------------------------------------------------

  async createRun(input: CreateRunInput): Promise<CreateRunResult> {
    const { definition, initial_payload, callback_url, metadata, project_id, created_by } = input;

    // C1: one entry template for the whole route. Resolved and loaded here so
    // a missing template fails before anything is written, and so the run row
    // can record which template the route belongs to.
    const entryTemplateSlug = resolveEntryTemplateSlug(definition, input.entry_template_slug);
    const entryTemplate = await loadEntryTemplate(this.db, project_id, entryTemplateSlug);

    // SMTP guard (lifecycle map §11.5): refuse to create a run with an
    // email_otp external_token step when SMTP is unconfigured. Absence of
    // the predicate counts as unconfigured (default-deny, mirrors route guard).
    // Checked BEFORE the insert transaction so nothing is half-created.
    await assertSmtpForExternalTokenSteps(
      this.db,
      project_id,
      definition.steps,
      this.isEmailConfigured,
      entryTemplateSlug,
    );

    const runId = generateId("chain_run");
    const runCreatedAt = new Date();

    // Merge user-provided metadata with definition metadata (definition wins
    // on key conflict — chain-definition-format §5). At run level,
    // `definition.metadata` is authoritative.
    const mergedMetadata = {
      ...(metadata || {}),
      ...(definition.metadata || {}),
    };

    // Insert one chain_steps row per definition step (1-based step_number to
    // match webhook payloads §8). `assignee_spec` stores the FULL step
    // definition — later materialisations read it back across the decision
    // → advance async boundary without holding the definition in memory.
    const stepRows = definition.steps.map((step, i) => ({
      id: generateId("chain_step"),
      chain_run_id: runId,
      step_number: i + 1,
      review_id: null as string | null,
      assignee_spec: step as unknown as Record<string, unknown>,
      depends_on: step.depends_on && step.depends_on.length > 0 ? step.depends_on : null,
      status: "pending",
      materialized_at: null as Date | null,
      // M13: persist per-step rejection disposition so the engine's handler
      // can dispatch abort / continue / branch at reject time. NULL stored
      // when unset — dispatcher defaults to 'abort'.
      rejection_policy: step.rejection_policy ?? null,
      rejection_branch_to: step.rejection_branch_to ?? null,
    }));

    // Atomic: both inserts share a transaction so a chain_steps failure
    // (e.g. CHECK constraint violation) rolls back the chain_runs row,
    // preventing half-born runs. assertTemplatesExist + materializeStep
    // stay OUTSIDE the tx (read-only validation + token generation).
    await this.db.transaction(async (tx) => {
      await tx.insert(chainRuns).values({
        id: runId,
        project_id,
        // C1: the route's entry template. The column has existed since M10 and
        // was written NULL by both entry paths; it is now the durable record of
        // which template a run belongs to, and the source materialisations after
        // the decision→advance boundary read back (entryTemplateSlugForRun).
        template_id: entryTemplate.id,
        name: definition.name || null,
        mode: definition.mode,
        rejection_policy: definition.rejection_policy,
        status: "active",
        metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : null,
        created_by,
        created_at: runCreatedAt,
      });
      await tx.insert(chainSteps).values(stepRows);
    });

    // Audit chain.created before step 1 so log ordering reads top-down.
    if (this.auditService) {
      await this.auditService.log({
        action: "chain.created",
        actor: created_by,
        resource_type: "chain_run",
        resource_id: runId,
        details: {
          mode: definition.mode,
          rejection_policy: definition.rejection_policy,
          step_count: definition.steps.length,
        },
        project_id: project_id,
      }).catch((err) => console.error("chain.created audit failed", { runId, err }));
    }

    // Step 1 skips chain.next_step_ready (spec §8 reserves it for N+1);
    // callers observe step 1 via the standard review.created webhook.
    //
    // Orphan-window tradeoff (accepted): the run + steps are already committed
    // by the transaction above, so materializeStep runs OUTSIDE the tx (it
    // inserts a review + may call tokenService.generate, which owns its own
    // tx — nesting would deadlock PGlite). If the step-1 template is deleted
    // in the gap between commit and materialize, this throws and leaves an
    // orphan 'active' run with no materialized step. That is the deliberate
    // cost of keeping token generation out of the createRun transaction.
    const stepOne = stepRows[0];
    const step1Review = await this.materializeStep({
      chainRunId: runId,
      stepRowId: stepOne.id,
      stepNumber: 1,
      stepDefinition: definition.steps[0],
      payload: initial_payload,
      prevReviewId: null,
      callbackUrl: callback_url || null,
      projectId: project_id,
      entryTemplateSlug,
      fireNextStepWebhook: false,
    });

    return {
      chain_run_id: runId,
      step_1_review_id: step1Review.id,
      status: "active",
    };
  }

  // --- Event handlers -----------------------------------------------------

  async onReviewDecided(data: EventData): Promise<void> {
    try {
      const [review] = await this.db
        .select()
        .from(reviews)
        .where(eq(reviews.id, data.review_id))
        .limit(1);

      if (!review || !review.chain_run_id || !review.chain_step_id) return;

      const [run] = await this.db
        .select()
        .from(chainRuns)
        .where(eq(chainRuns.id, review.chain_run_id))
        .limit(1);
      if (!run || run.status !== "active") return;

      // Atomic claim: single UPDATE with WHERE status='active' RETURNING.
      // If the step was already flipped (duplicate event or concurrent
      // handler), RETURNING yields 0 rows and we short-circuit — no
      // double-advance, no separate SELECT needed.
      const stepId = review.chain_step_id!;
      // Legacy POST /decide with action=approve + payload edits sets
      // decision="edited" (execute-action.ts additionalFields override).
      // Treat "edited" as "approved" — the human approved with edits; payload
      // forwarding already prefers edited_payload over the original payload.
      if (review.decision === "approved" || review.decision === "edited") {
        const [claimedStep] = await this.db.update(chainSteps)
          .set({ status: "approved" })
          .where(and(eq(chainSteps.id, stepId), eq(chainSteps.status, "active")))
          .returning();
        if (!claimedStep) return;
        await this.handleApprove(run, claimedStep, review);
      } else if (review.decision === "rejected") {
        const [claimedStep] = await this.db.update(chainSteps)
          .set({ status: "rejected" })
          .where(and(eq(chainSteps.id, stepId), eq(chainSteps.status, "active")))
          .returning();
        if (!claimedStep) return;
        await this.handleReject(run, claimedStep, review);
      }
    } catch (err) {
      await this.emitStepHalted(data, err);
      console.error("ChainEngine onReviewDecided failed", { review_id: data.review_id, err });
    }
  }

  async onReviewExpired(data: EventData): Promise<void> {
    try {
      const [review] = await this.db.select().from(reviews)
        .where(eq(reviews.id, data.review_id)).limit(1);
      if (!review || !review.chain_run_id || !review.chain_step_id) return;
      const [run] = await this.db.select().from(chainRuns)
        .where(eq(chainRuns.id, review.chain_run_id)).limit(1);
      if (!run || run.status !== "active") return;
      const [updated] = await this.db.update(chainSteps)
        .set({ status: "rejected" })
        .where(and(eq(chainSteps.id, review.chain_step_id), eq(chainSteps.status, "active")))
        .returning();
      if (!updated) return; // already processed (idempotent)
      await this.handleReject(run, updated, review);
    } catch (err) {
      await this.emitStepHalted(data, err);
      console.error("ChainEngine onReviewExpired failed", { review_id: data.review_id, err });
    }
  }

  // --- Private ------------------------------------------------------------

  private engineDeps() {
    return {
      db: this.db,
      auditService: this.auditService,
      webhooks: this.webhooks,
      getHmacSecret: (p: string) => this.getHmacSecret(p),
    };
  }

  // Private delegate: kept so existing tests that call (engine as any).emitStepHalted
  // continue to work. Logic lives in chain-engine-abort.ts (600 LOC cap).
  private async emitStepHalted(data: EventData, err: unknown): Promise<void> {
    return emitStepHalted(this.engineDeps(), data, err);
  }

  private async handleApprove(
    run: ChainRunRow,
    currentStep: ChainStepRow,
    currentReview: ReviewRow,
  ): Promise<void> {
    // Concurrent-abort guard (see chainRunStillActive). The just-claimed current
    // step stays approved (human decided pre-abort); we only stop progression.
    if (!(await chainRunStillActive(this.db, run.id))) return;

    // Find next step. In sequential mode, "next" = step_number + 1.
    const [nextStep] = await this.db
      .select()
      .from(chainSteps)
      .where(
        and(
          eq(chainSteps.chain_run_id, run.id),
          eq(chainSteps.step_number, currentStep.step_number + 1),
        ),
      )
      .limit(1);

    if (!nextStep) {
      await this.completeRun(run, currentReview);
      return;
    }

    // Propagate payload. Edits and approved_value from the current step
    // flow forward so reviewers downstream see the latest state.
    const nextPayload = (currentReview.approved_value as Record<string, unknown> | null)
      || (currentReview.edited_payload as Record<string, unknown> | null)
      || (currentReview.payload as Record<string, unknown>);

    // Look up the definition step via the assignee_spec we stored at
    // createRun time. We round-trip through chain_steps because the
    // engine no longer holds the full definition object at this point.
    const stepDefinition = this.reconstructStepDefinition(nextStep);

    await this.materializeStep({
      chainRunId: run.id,
      stepRowId: nextStep.id,
      stepNumber: nextStep.step_number,
      stepDefinition,
      payload: nextPayload,
      prevReviewId: currentReview.id,
      callbackUrl: currentReview.callback_url,
      projectId: run.project_id,
      entryTemplateSlug: await entryTemplateSlugForRun(this.db, run),
      fireNextStepWebhook: true,
    });
  }

  private async handleReject(
    run: ChainRunRow,
    currentStep: ChainStepRow,
    currentReview: ReviewRow,
  ): Promise<void> {
    if (!(await chainRunStillActive(this.db, run.id))) return;

    // M13: delegate to the per-step rejection dispatcher. The dispatcher
    // reads `currentStep.rejection_policy` and applies abort / continue /
    // branch; chain_runs.rejection_policy (M10) is passed through for audit
    // but no longer controls the engine branch — step-level policy wins.
    await applyStepRejection(
      {
        db: this.db,
        webhooks: this.webhooks,
        eventBus: this.eventBus,
        auditService: this.auditService,
        // C1: the continue and branch paths re-materialise a step and need
        // the route's entry template, just as handleApprove does. Passed as a
        // THUNK rather than a resolved value, because the default policy —
        // abort — re-materialises nothing and must not depend on a template
        // lookup at all. Resolving eagerly meant a rejection on a run whose
        // template had been deleted threw AFTER the step was claimed
        // 'rejected', which the engine swallows into chain.step_halted,
        // leaving the run 'active' with no active step: a state the
        // reconciler cannot see, and so a permanent silent strand.
        entryTemplateSlug: () => entryTemplateSlugForRun(this.db, run),
        materializeStep: (args) => this.materializeStep(args),
        buildTranscript: (id) => this.buildTranscript(id),
        getHmacSecret: (id) => this.getHmacSecret(id),
        reconstructStepDefinition: (s) => this.reconstructStepDefinition(s),
        completeRun: (r, review) => this.completeRun(r, review),
      },
      run,
      currentStep,
      currentReview,
    );
  }

  private async completeRun(run: ChainRunRow, finalReview: ReviewRow): Promise<void> {
    const completedAt = new Date();
    // Guarded terminal write (atomic w.r.t. run status): a concurrent
    // POST /chain-runs/:id/abort can commit status='aborted' AFTER the caller's
    // chainRunStillActive recheck but BEFORE this UPDATE. WHERE status='active'
    // makes abort win — 0 rows → bail before emitting a misleading
    // chain.completed audit + webhook over an already-aborted run.
    const [terminalized] = await this.db
      .update(chainRuns)
      .set({ status: "completed", completed_at: completedAt })
      .where(and(eq(chainRuns.id, run.id), eq(chainRuns.status, "active")))
      .returning();
    if (!terminalized) return;

    if (this.auditService) {
      await this.auditService.log({
        action: "chain.completed",
        actor: finalReview.decided_by || "system:chain",
        resource_type: "chain_run",
        resource_id: run.id,
        details: {
          final_review_id: finalReview.id,
          completed_at: completedAt.toISOString(),
        },
        project_id: run.project_id,
      }).catch((err) => console.error("chain.completed audit failed", { runId: run.id, err }));
    }

    if (finalReview.callback_url) {
      const hmacSecret = await this.getHmacSecret(run.project_id);
      if (hmacSecret !== null) {
        const transcript = await this.buildTranscript(run.id);
        this.webhooks.sendChainCompleted({
          callback_url: finalReview.callback_url,
          hmac_secret: hmacSecret,
          chain_run_id: run.id,
          final_review_id: finalReview.id,
          initial_review_id: await this.initialReviewId(run.id),
          // Sourced from finalReview, which is already in hand — no extra query.
          final_decision: finalReview.decision,
          decided_by: finalReview.decided_by,
          decided_at: finalReview.decided_at ? finalReview.decided_at.toISOString() : null,
          approved_value: finalReview.approved_value as Record<string, unknown> | null,
          edited_payload: finalReview.edited_payload as Record<string, unknown> | null,
          was_edited: !!finalReview.edited_payload,
          iteration_count: finalReview.current_version - 1,
          completed_at: completedAt.toISOString(),
          rejection_policy: run.rejection_policy,
          metadata: run.metadata as Record<string, unknown> | null,
          transcript,
        }).catch((err) => console.error("chain.completed webhook failed", { runId: run.id, err }));
      }
    }

    // The bus emit fires for EVERY chain, including agent-started ones. It is
    // the SSE channel and, since C1 §5.1, the channel the SDK wait helpers
    // depend on to learn that a route finished — gating it on a human owner
    // meant the agent-started chains that most need it never saw it.
    //
    // Only the notification TARGET is owner-dependent. An agent-started chain
    // has no human to tap, and the review's assignee at this point is the last
    // decider, who already knows. PersonalNotifier drops a chain terminal event
    // with no notify_assignee rather than falling back to them.
    const chainOwner = chainOwnerEmail(run.created_by);
    this.eventBus.emit("chain.completed", {
      review_id: finalReview.id,
      template: finalReview.template_slug,
      project_id: run.project_id,
      priority: finalReview.priority as Priority,
      created_at: completedAt.toISOString(),
      ...(chainOwner ? { notify_assignee: chainOwner } : {}),
    });
  }

  /**
   * The run's step-1 review: the id the requester was handed at creation, and
   * therefore the one a consumer suspended against a review id can key on.
   */
  private async initialReviewId(chainRunId: string): Promise<string | null> {
    const [first] = await this.db
      .select({ review_id: chainSteps.review_id })
      .from(chainSteps)
      .where(and(eq(chainSteps.chain_run_id, chainRunId), eq(chainSteps.step_number, 1)))
      .limit(1);
    return first?.review_id ?? null;
  }

  private async materializeStep(args: {
    chainRunId: string;
    stepRowId: string;
    stepNumber: number;
    stepDefinition: ChainDefinitionStep;
    payload: Record<string, unknown>;
    prevReviewId: string | null;
    callbackUrl: string | null;
    projectId: string;
    /** C1: the route's entry template. Every step materialises against it. */
    entryTemplateSlug: string;
    fireNextStepWebhook: boolean;
  }): Promise<ReviewRow> {
    const { chainRunId, stepRowId, stepNumber, stepDefinition, payload, prevReviewId,
      callbackUrl, projectId, entryTemplateSlug, fireNextStepWebhook } = args;

    // C1: resolve the ENTRY template, not the step's. A chain is a route of
    // approvers over one request, so every step reviews the same payload
    // against the same form — there is no second form to mismatch, and an edit
    // made at step 1 lands in fields step 2 actually renders.
    //
    // Re-validated at each materialisation (not cached from createRun) so
    // template deletion mid-chain surfaces here, not silently via a NULL
    // template_id on the review.
    const [tpl] = await this.db
      .select()
      .from(templates)
      .where(and(eq(templates.slug, entryTemplateSlug), eq(templates.project_id, projectId)))
      .limit(1);
    if (!tpl) {
      throw new InvalidRequestError(
        `Template '${entryTemplateSlug}' not found for step ${stepNumber}`,
        "template",
        "template_not_found",
      );
    }

    // Resolve assignee. For kind=user and kind=role we set the assignee
    // column; for kind=external_token we generate a token AFTER the review
    // is created (token_hash references review_id).
    const resolvedAssignee = await this.resolveAssignee(stepDefinition.assignee, projectId);

    const reviewId = generateId("review");
    const reviewCreatedAt = new Date();

    const [createdReview] = await this.db.insert(reviews).values({
      id: reviewId,
      project_id: projectId,
      template_id: tpl.id,
      template_slug: tpl.slug,
      template_fields: normalizeTemplateFields(tpl.fields),
      payload,
      priority: stepDefinition.priority || tpl.default_priority,
      actions: tpl.actions,
      assignee: resolvedAssignee,
      callback_url: callbackUrl,
      status: "pending",
      // Belt-and-suspenders for spec Q5: chain steps are ALWAYS blocking.
      // The creation-time gate already refuses monitoring on chain templates;
      // this pin holds even if a template-level oversight default is ever added.
      oversight: "blocking",
      timeout_seconds: stepDefinition.timeout_seconds || tpl.timeout_seconds,
      // INVARIANT: chain advancement is human-only by construction.
      //
      // The TimeoutWorker's auto_approve branch emits review.decided, and this
      // engine subscribes review.decided to its ADVANCE handler. So a template
      // configured "auto_approve on timeout" would let a background worker
      // decide a chain step and advance the run with decided_by='system:timeout'.
      // That path is dormant today only because expires_at is never written
      // here, which makes it a landmine: populating expires_at alone would arm
      // it. Pinning the action makes it dormant
      // by DESIGN instead — whoever later writes expires_at gets an expiry,
      // which onReviewExpired already handles as a rejection, never a system
      // approval. Route model raises the stakes: under one entry template a
      // single auto_approve setting would govern every step of every route.
      timeout_action: "expire",
      // Deliberately NOT inherited from the template: max_iterations. Its
      // worker path (TimeoutWorker.closeMaxIterations) has NO expires_at gate,
      // so unlike the timeout path it is not dormant — it would fire on any
      // chain step that reached its iteration cap and emit
      // decision='max_iterations_reached', a value onReviewDecided does not
      // handle, leaving the step 'active' forever. The standalone create path
      // inherits it (routes/reviews/crud.ts); the chain path must not.
      metadata: stepDefinition.metadata || null,
      chain_run_id: chainRunId,
      chain_step_id: stepRowId,
      prev_step_ids: prevReviewId ? [prevReviewId] : [],
      current_version: 1,
      ladder_index: 0,
      created_at: reviewCreatedAt,
      updated_at: reviewCreatedAt,
    }).returning();

    // Flip the step to active + link the review — guarded, atomic w.r.t. run
    // status (see flipStepActiveGuarded: status='pending' AND EXISTS(run active)
    // at the UPDATE instant; closes the branch-path abort race with no TOCTOU).
    // On a miss (step skipped OR run aborted) close the just-inserted review so
    // it isn't orphaned, and bail before token gen / webhook / SSE (a direct
    // UPDATE emits no event → no feedback loop). createRun's step 1 is 'pending'
    // under an 'active' run, so the guard matches normally there.
    const flipped = await flipStepActiveGuarded(this.db, {
      stepRowId,
      chainRunId,
      reviewId: createdReview.id,
      at: reviewCreatedAt,
    });
    if (!flipped) {
      await this.db
        .update(reviews)
        .set({ status: "expired", updated_at: new Date() })
        .where(eq(reviews.id, createdReview.id));
      return createdReview;
    }

    // External-token assignees: generate + include URL in webhook payload.
    // Auth-tier integration (§13). Override-chain resolution lives in
    // chain-engine-token-resolution.ts (pure helper extracted to keep this
    // file under the 600 LOC cap).
    let externalTokenUrl: string | undefined;
    if (stepDefinition.assignee.kind === "external_token") {
      const resolved = resolveChainTokenInputs(stepDefinition, tpl);
      const { rawToken, tokenRecord } = await this.tokenService.generate({
        review_id: createdReview.id,
        project_id: projectId,
        purpose: resolved.purpose,
        recipient_label: resolved.recipient_label,
        auth_level: resolved.auth_level,
        auth_email: resolved.auth_email,
        auth_user_id: resolved.auth_user_id,
        created_by_kind: "chain",
        created_by_id: stepRowId,
        expiryHours: resolved.expiryHours,
      });
      externalTokenUrl = `/r/${rawToken}`;

      // Token-redesign Phase 1 (spec §9): emit token.created from the chain
      // path so audit consumers see uniform coverage across manual / agent /
      // chain trigger paths. Mirrors the route handler's emission shape with
      // chain context attached.
      //
      // PII-as-type-absence: the
      // audit `details` payload MAY include `auth_level` (operator-set,
      // not recipient-derived) but MUST NOT include `auth_email` or
      // `auth_user_id`.
      this.auditService?.log({
        action: "token.created",
        actor: "system:chain",
        resource_type: "review",
        resource_id: createdReview.id,
        details: {
          token_id: tokenRecord.id,
          expires_at: tokenRecord.expires_at,
          created_by_kind: "chain",
          chain_run_id: chainRunId,
          chain_step_id: stepRowId,
          auth_level: resolved.auth_level,
        },
        project_id: projectId,
      }).catch((err) => console.error("token.created audit failed", { stepRowId, err }));
    }

    if (this.auditService) {
      await this.auditService.log({
        action: "chain.step_materialized",
        actor: "system:chain",
        resource_type: "chain_step",
        resource_id: stepRowId,
        details: {
          chain_run_id: chainRunId,
          step_number: stepNumber,
          review_id: createdReview.id,
          assignee_kind: stepDefinition.assignee.kind,
        },
        project_id: projectId,
      }).catch((err) => console.error("chain.step_materialized audit failed", { stepRowId, err }));
    }

    if (fireNextStepWebhook && callbackUrl) {
      const hmacSecret = await this.getHmacSecret(projectId);
      if (hmacSecret !== null) {
        // PII-as-type-absence:
        // strip auth_email + auth_user_id from the assignee snapshot before
        // emit. Without this scrub, every chain webhook delivery on
        // email_otp / account tiers would leak the recipient's PII to the
        // operator's webhook receiver. Single-source helper shared with
        // buildTranscript + GET projections in routes/chains.ts.
        //
        // auth_level passes through (operator-set, not recipient-derived).
        // recipient_label and purpose pass through (operator-authored UI
        // labels with no PII expectation).
        const sanitizedSpec = scrubAssigneeSpecPii(
          stepDefinition as unknown as Record<string, unknown>,
        );
        const sanitizedAssignee = (sanitizedSpec?.assignee ?? {
          kind: stepDefinition.assignee.kind,
        }) as Record<string, unknown>;

        this.webhooks.sendChainNextStepReady({
          callback_url: callbackUrl,
          hmac_secret: hmacSecret,
          chain_run_id: chainRunId,
          step_number: stepNumber,
          step_id: stepRowId,
          step_name: stepDefinition.name || null,
          previous_step_id: prevReviewId,
          next_review_id: createdReview.id,
          external_token_url: externalTokenUrl,
          assignee: sanitizedAssignee,
          created_at: reviewCreatedAt.toISOString(),
        }).catch((err) => console.error("chain.next_step_ready webhook failed", { runId: chainRunId, err }));
      }
    }

    // SSE emit for step N+1 materialisations (handleApprove and chain-
    // rejection continue/branch flows). Step 1 is emitted at the route
    // layer (chains.ts POST /chain-runs and crud.ts POST /reviews chain-
    // spawn branch) which means fireNextStepWebhook=false on createRun;
    // we use that flag as the cleanest "is this step 1" predicate so
    // step 1 doesn't double-emit.
    if (fireNextStepWebhook) {
      const counts = await loadChainStepCounts(this.db, chainRunId);
      const chainCtx = counts
        ? chainEventFieldsFromCache(chainRunId, stepRowId, counts)
        : null;
      const eventData = {
        review_id: createdReview.id,
        template: createdReview.template_slug,
        project_id: createdReview.project_id,
        priority: createdReview.priority as Priority,
        created_at: createdReview.created_at.toISOString(),
        ...(chainCtx ?? {}),
      };
      this.eventBus.emit("review.created", eventData);
      if (createdReview.priority === "high" || createdReview.priority === "critical") {
        this.eventBus.emit("review.urgent", eventData);
      }
    }

    return createdReview;
  }

  private reconstructStepDefinition(step: ChainStepRow): ChainDefinitionStep {
    // `assignee_spec` stores the full step definition (see createRun).
    const spec = step.assignee_spec as unknown as ChainDefinitionStep | null;
    // C1: `template` is no longer required on a step — the route carries one
    // entry template — so only the assignee is load-bearing here.
    if (!spec || typeof spec !== "object" || !spec.assignee) {
      throw new Error(
        `chain_steps.assignee_spec malformed for ${step.id}; chain cannot materialise next step`,
      );
    }
    return spec;
  }

  private async resolveAssignee(spec: AssigneeSpec, projectId: string): Promise<string | null> {
    if (spec.kind === "user") {
      if (spec.user_id) return spec.user_id;
      if (spec.email) {
        // Lookup reviewers for canonical user_id; fall back to storing the
        // raw email when no row exists (matches M9 ladder behaviour — many
        // OSS deployments run without populated reviewer rows). Strict
        // resolution (V8 `assignee_user_not_found`) deferred to Cloud.
        const [user] = await this.db
          .select()
          .from(reviewers)
          .where(eq(reviewers.email, spec.email))
          .limit(1);
        return user?.id || spec.email;
      }
      throw new InvalidRequestError(
        "user assignee requires email or user_id",
        "assignee",
        "assignee_user_missing_ref",
      );
    }
    if (spec.kind === "role") {
      // Role resolution happens at inbox-query time; store `role:<name>`
      // so audit + logs make the binding visible.
      return `role:${spec.role}`;
    }
    // external_token: assignee stays null; URL surfaces via sendChainNextStepReady.
    void projectId;
    return null;
  }

  // Delegate: logic extracted to chain-engine-abort.ts (600 LOC cap).
  // PII scrub comment lives with the implementation there.
  private async buildTranscript(chainRunId: string): Promise<Array<Record<string, unknown>>> {
    return buildTranscriptImpl(this.db, chainRunId);
  }

  private async getHmacSecret(projectId: string): Promise<string | null> {
    const [proj] = await this.db
      .select({ hmac_secret: projects.hmac_secret })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!proj) {
      console.error("ChainEngine: project not found during HMAC lookup", { projectId });
      return null;
    }
    return proj.hmac_secret;
  }

  // --- Reconciliation sweep -----------------------------------------------
  //
  // Heavy logic lives in chain-engine-reconcile.ts (600 LOC cap extraction).
  // These three members are the thin wiring layer that stays here.

  /** Re-drive stranded active steps whose review is already terminal. */
  async reconcile(): Promise<{ redriven: number; halted: number }> {
    return reconcileImpl({ db: this.db, onReviewDecided: (d) => this.onReviewDecided(d), onReviewExpired: (d) => this.onReviewExpired(d), haltOrphan: (d, e) => this.emitStepHalted(d, e) });
  }

  private reconcileInterval: ReturnType<typeof setInterval> | null = null;

  /** Start the periodic reconciliation sweep (default: every 60 s). */
  start(intervalMs = 60_000): void {
    if (this.reconcileInterval) return;
    this.reconcileInterval = setInterval(() => { this.reconcile().catch((err) => console.error("Chain reconcile error:", err)); }, intervalMs);
  }

  /** Stop the periodic reconciliation sweep. */
  stop(): void {
    if (this.reconcileInterval) clearInterval(this.reconcileInterval);
    this.reconcileInterval = null;
  }
}

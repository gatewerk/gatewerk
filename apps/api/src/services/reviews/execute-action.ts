// executeReviewAction — the load+normalize+invoke+persist+emit pipeline that
// underpins both POST /reviews/:id/action AND the legacy /decide /retry /
// cancel-request aliases. Phase 3 of v1.4 configurable-actions (spec §11.2 +
// §14 Phase 3 commit 1).
//
// Single state-machine source of truth: invokeAction. Every public route
// converges on this helper so cross-cutting behavior (audit, webhook dispatch,
// optimistic locking, race-safe UPDATE, chain context threading) lives in
// one place.
//
// Auth + chain-step gating (assertChainStepAllows) stay at the route layer
// because they vary by trigger path — the new /action endpoint is reviewer-
// session only, the legacy aliases accept api-key + session, and Phase 7's
// chain/token routes will have their own auth shapes.
//
// Result error codes (action.unknown_action, version_mismatch, etc.) are
// propagated as ConflictError / InvalidRequestError per the existing wire
// convention; callers don't need to map.

import { eq, and } from "drizzle-orm";
import {
  projects,
  reviews as reviewsTable,
  templates,
} from "@gatewerk/db/src/schema/index";
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  NOTIFICATION_EVENTS,
  DEFAULT_ACTION_PRESETS,
  isIterationStatus,
  normalizeTemplateActions,
  type NotificationEvent,
  type Priority,
  type ReviewStatus,
  type TemplateActionConfig,
  type TriggerPath,
} from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import { invokeAction, type ActionActor } from "./actions";
import { assertEditedPayloadAllowed, type EditableFieldSpec } from "./editable-fields";
import { dispatchActionWebhooks } from "./action-webhook-dispatch";
import { resolveChainEventFields } from "../../lib/chain-event-context";
import type { WebhookService } from "../webhooks";
import type { EventBus } from "../events";
import type { createAuditService } from "../audit";

export interface ExecuteReviewActionInput {
  db: AppDb;
  webhooks: WebhookService;
  eventBus?: EventBus;
  auditService?: ReturnType<typeof createAuditService>;
  reviewId: string;
  projectId: string;
  actor: ActionActor;
  triggerPath: TriggerPath;
  actionId: string;
  feedback?: string;
  editedPayload?: Record<string, unknown>;
  expectedVersion?: number;
  requestId?: string;
  /**
   * Legacy carry-through columns set on the same UPDATE as the action's
   * persistence. /decide /retry /cancel-request aliases pass prompt_edit,
   * action_value, action_label here to preserve historic SDK contracts.
   * Empty / undefined for the new /action endpoint.
   */
  additionalFields?: Partial<typeof reviewsTable.$inferInsert>;
  /**
   * Action configurations that take precedence over user-authored template
   * actions and system presets during the invokeAction lookup. Used by
   * legacy aliases to preserve historic semantics that diverge from the
   * canonical preset (e.g. /decide accepted decision='rejected' without
   * feedback, but the canonical REJECT preset has requires_feedback=true).
   * Prepended to the snapshot — Array.find returns the first match by id.
   */
  snapshotPrepend?: TemplateActionConfig[];
}

export type ReviewRow = typeof reviewsTable.$inferSelect;

export async function executeReviewAction(
  input: ExecuteReviewActionInput,
): Promise<ReviewRow> {
  const {
    db,
    webhooks: wh,
    eventBus,
    auditService,
    reviewId,
    projectId,
    actor,
    triggerPath,
    actionId,
    feedback,
    editedPayload,
    expectedVersion,
    requestId,
    additionalFields,
    snapshotPrepend,
  } = input;

  // Load review.
  const [reviewRow] = await db
    .select()
    .from(reviewsTable)
    .where(
      and(
        eq(reviewsTable.id, reviewId),
        eq(reviewsTable.project_id, projectId),
      ),
    )
    .limit(1);
  if (!reviewRow) {
    throw new NotFoundError("Review not found", "review_not_found");
  }

  // Monitoring reviews accept ONLY veto/confirm via their dedicated
  // endpoints (spec §4.4 status-by-decision matrix). Approve/reject/edit/
  // retry/cancel are all meaningless against an already-executed action.
  if (reviewRow.status === "monitoring") {
    throw new ConflictError(
      "Review is in a monitoring window. Use veto or confirm.",
      "monitoring_requires_veto_or_confirm",
    );
  }

  // Pre-empt invokeAction's generic action.status_not_allowed for the legacy
  // terminal states. Mirrors the legacy decide.ts service error codes that
  // SDK consumers branch on (review_already_decided, review_expired,
  // review_awaiting_changes for decision-kind actions on iteration reviews).
  // Skipped for cancel_iteration which is explicitly enabled_for_status:
  // ['changes_requested', 'awaiting_iteration'] — the action service handles
  // it correctly via the action-config's enabled_for_status check.
  if (actionId !== "cancel_iteration") {
    if (reviewRow.status === "decided") {
      throw new ConflictError(
        `Review already decided by ${reviewRow.decided_by || "another reviewer"}`,
        "review_already_decided",
      );
    }
    if (reviewRow.status === "expired") {
      throw new ConflictError("Review has expired", "review_expired");
    }
    // Iteration-state guard applies only to decision-kind action_ids
    // (approve, reject) — request_changes IS valid on iteration reviews
    // when the legacy /retry flow re-iterates without an intervening cancel.
    // Wait — actually legacy /retry only allowed pending → changes_requested,
    // not iteration → iteration. Match that semantic by gating on action_id.
    if (
      isIterationStatus(reviewRow.status) &&
      (actionId === "approve" || actionId === "reject")
    ) {
      throw new ConflictError(
        "Review is awaiting changes from the agent",
        "review_awaiting_changes",
      );
    }
  }

  // Load template + normalize action snapshot. Inject system presets that
  // aren't already in the template's authored actions so legacy aliases
  // (/retry, /cancel-request) work uniformly across all templates regardless
  // of what the user configured. Templates that customize a preset (e.g.,
  // an "approve" action with custom label) override the system version
  // because user actions are added first and `userIds` blocks the system
  // preset from being added on top.
  const [tpl] = await db
    .select({
      actions: templates.actions,
      fields: templates.fields,
      allow_request_changes: templates.allow_request_changes,
    })
    .from(templates)
    .where(
      and(
        eq(templates.slug, reviewRow.template_slug),
        eq(templates.project_id, projectId),
      ),
    )
    .limit(1);
  const userActions = normalizeTemplateActions(tpl?.actions);
  // snapshotPrepend goes first so legacy aliases can override canonical
  // preset semantics (e.g. requires_feedback=false on the legacy /decide
  // reject path). Array.find returns the first match by id.
  const prependedIds = new Set((snapshotPrepend ?? []).map((a) => a.id));
  const userIds = new Set(userActions.map((a) => a.id));
  const snapshot: TemplateActionConfig[] = [
    ...(snapshotPrepend ?? []),
    ...userActions.filter((a) => !prependedIds.has(a.id)),
  ];
  for (const presetKey of Object.keys(DEFAULT_ACTION_PRESETS) as Array<
    keyof typeof DEFAULT_ACTION_PRESETS
  >) {
    if (!userIds.has(presetKey) && !prependedIds.has(presetKey)) {
      snapshot.push(DEFAULT_ACTION_PRESETS[presetKey]);
    }
  }

  // Pure-fn dispatch.
  const result = invokeAction({
    review: {
      id: reviewRow.id,
      status: reviewRow.status as ReviewStatus,
      current_version: reviewRow.current_version,
      template_actions_snapshot: snapshot,
    },
    actionId,
    actor,
    triggerPath,
    feedback,
    editedPayload,
    expectedVersion,
  });

  if (!result.ok) {
    if (result.code === "version_mismatch") {
      throw new ConflictError(result.message, "version_mismatch");
    }
    if (result.code === "action.status_not_allowed") {
      throw new ConflictError(result.message, result.code);
    }
    throw new InvalidRequestError(result.message, result.field, result.code);
  }

  // Server-side `field.editable` enforcement. Placed after
  // the action dispatch so an invalid action still reports its own error first,
  // but before ANY branch consumes editedPayload — the decision branch writes
  // it to edited_payload/approved_value, and the iteration branch echoes it
  // into the audit row and the webhook. Both must be gated, or the ledger
  // asserts an edit the template forbids.
  //
  // Field specs come from the review's creation-time snapshot so a template
  // edit cannot retroactively widen what an in-flight review accepts (the same
  // P8 isolation reviews already get for rendering). Pre-snapshot rows fall
  // back to the live template.
  assertEditedPayloadAllowed(
    editedPayload,
    reviewRow.payload as Record<string, unknown> | null,
    (reviewRow.template_fields ?? tpl?.fields) as EditableFieldSpec[] | null,
  );

  // `allow_request_changes` gate. The column shipped with a
  // DB default of TRUE, was validated on both body schemas, and was projected
  // onto every review response — with ZERO readers anywhere in the repo. A
  // template that set it false still accepted iteration actions, so the knob
  // silently did nothing. (The schema comment claiming templates "opt out via
  // TemplateEditor toggles" described a toggle that does not exist.)
  //
  // Gated on the resolved action's KIND rather than the id `request_changes`,
  // because preset injection means that id succeeds on every template whether
  // authored or not, and a template's own custom iteration actions must obey
  // the same switch. `cancel_iteration` is kind side_effect and so stays
  // available — otherwise disabling the flag would strand any review already
  // sitting in awaiting_iteration.
  if (
    result.stateUpdate.last_action_kind === "iteration" &&
    tpl?.allow_request_changes === false
  ) {
    throw new InvalidRequestError(
      "This template does not allow requesting changes. Approve or reject instead, or enable 'Allow request changes' on the template.",
      "action_id",
      "request_changes_not_allowed",
    );
  }

  // Atomic UPDATE with version + status guard. additionalFields are applied
  // LAST so legacy aliases (e.g., /decide with decision="edited") can override
  // canonical column values produced by the action service. Without this
  // ordering, the kind=decision branch's setFields.decision = "approved"
  // would clobber an alias's additionalFields.decision = "edited".
  const setFields: Partial<typeof reviewsTable.$inferInsert> = {
    status: result.stateUpdate.status,
    last_action_id: result.stateUpdate.last_action_id,
    last_action_kind: result.stateUpdate.last_action_kind,
    last_action_at: result.stateUpdate.last_action_at,
    last_action_by: result.stateUpdate.last_action_by,
    updated_at: new Date(),
  };

  if (result.stateUpdate.last_action_kind === "decision") {
    setFields.decision = result.stateUpdate.decision;
    setFields.decided_at = result.stateUpdate.decided_at;
    setFields.decided_by = result.stateUpdate.decided_by;
    setFields.decided_by_verified = result.stateUpdate.decided_by_verified ?? null;
    setFields.edited_payload = editedPayload ?? null;
    setFields.approved_value = (editedPayload ?? reviewRow.payload) as
      | Record<string, unknown>
      | null;
    if (feedback) setFields.feedback = feedback;
    setFields.draft_payload = null;
    setFields.draft_by = null;
    setFields.draft_at = null;
  } else if (result.stateUpdate.last_action_kind === "iteration") {
    if (feedback) setFields.feedback = feedback;
    setFields.draft_payload = null;
    setFields.draft_by = null;
    setFields.draft_at = null;
  } else if (
    result.stateUpdate.last_action_kind === "side_effect" &&
    actionId === "cancel_iteration"
  ) {
    // Cancel preset (spec §S14): mirror legacy /cancel-request behavior —
    // clear the iteration's feedback so the review returns to a clean
    // pending state, and clear any in-progress draft.
    setFields.feedback = null;
    setFields.draft_payload = null;
    setFields.draft_by = null;
    setFields.draft_at = null;
  }

  // Legacy alias overrides apply last, after the action-kind branch wrote its
  // canonical defaults. Used by /decide for decision="edited" → decision col
  // override + by all aliases for prompt_edit / action_value / action_label.
  if (additionalFields) {
    Object.assign(setFields, additionalFields);
  }

  const [updated] = await db
    .update(reviewsTable)
    .set(setFields)
    .where(
      and(
        eq(reviewsTable.id, reviewId),
        eq(reviewsTable.project_id, projectId),
        eq(reviewsTable.current_version, reviewRow.current_version),
      ),
    )
    .returning();

  if (!updated) {
    // Race-loss path: another writer mutated current_version between SELECT
    // and UPDATE. Re-fetch the row and throw a specific ConflictError based
    // on the post-conflict state, mirroring legacy decide.ts service errors
    // so SDK consumers branching on error.code (review_already_decided,
    // review_expired, review_awaiting_changes) keep working.
    const [existing] = await db
      .select()
      .from(reviewsTable)
      .where(
        and(
          eq(reviewsTable.id, reviewId),
          eq(reviewsTable.project_id, projectId),
        ),
      )
      .limit(1);
    if (existing?.status === "decided") {
      throw new ConflictError(
        `Review already decided by ${existing.decided_by || "another reviewer"}`,
        "review_already_decided",
      );
    }
    if (existing?.status === "expired") {
      throw new ConflictError("Review has expired", "review_expired");
    }
    if (existing && isIterationStatus(existing.status)) {
      throw new ConflictError(
        "Review is awaiting changes from the agent",
        "review_awaiting_changes",
      );
    }
    throw new ConflictError(
      "Review modified concurrently. Please refetch and retry.",
      "version_mismatch",
    );
  }

  // Audit log (fire-and-forget, mirrors decide.ts pattern).
  if (auditService) {
    auditService
      .log({
        action: result.audit.action,
        actor: result.audit.actor,
        resource_type: result.audit.resource_type,
        resource_id: result.audit.resource_id,
        details: result.audit.details,
        project_id: projectId,
      })
      .catch(() => {});
  }

  // Outbound HTTP delivery to user-supplied callback_url.
  if (updated.callback_url) {
    const [proj] = await db
      .select({ hmac_secret: projects.hmac_secret })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (proj) {
      const promises = dispatchActionWebhooks({
        wh,
        webhooks: result.webhooks,
        callbackUrl: updated.callback_url,
        hmacSecret: proj.hmac_secret,
        reviewId: updated.id,
        chainRunId: updated.chain_run_id,
        actionKind: result.stateUpdate.last_action_kind,
        decision: updated.decision,
        decidedAt: updated.decided_at,
        decidedBy: updated.decided_by,
        approvedValue: updated.approved_value as Record<string, unknown> | null,
        suggestedValue: updated.suggested_value as Record<string, unknown> | null,
        editedPayload: updated.edited_payload as Record<string, unknown> | null,
        feedback: updated.feedback,
        actionId: result.audit.details.action_id,
        actionLabel: result.audit.details.action_label,
        // Derived: number of revision rounds. ALWAYS current_version - 1
        // (0 when decided on the first version). The frozen decision callback
        // contract requires iteration_count present on every decision webhook,
        // matching the always-present HTTP serialization layer.
        iterationCount: updated.current_version - 1,
        requestId,
      });
      Promise.all(promises).catch(console.error);

      // C1 (charter §5.1): the chain's own decision event. review.decided is
      // withheld for a chain-attached review because it cannot be told apart
      // from final authorization; this is what carries the step's decision
      // instead, with the chain context that payload lacks.
      //
      // Fired here rather than from ChainEngine deliberately. The engine emits
      // its step events from materializeStep, which the final step never
      // reaches (handleApprove goes straight to completeRun), and it wraps
      // onReviewDecided in a try/catch that turns a materialisation failure
      // into chain.step_halted. So an engine-fired step event would be missing
      // exactly when an operator most needs it: on the last approval, and when
      // a human decided but the chain could not move. Both cases are covered in
      // chain-step-decided.test.ts. This path runs before any of that, and
      // anchors the delivery to the review that actually decided.
      if (updated.chain_run_id && result.stateUpdate.last_action_kind === "decision") {
        const chainCtx = await resolveChainEventFields(
          db,
          updated.chain_run_id,
          updated.chain_step_id,
        );
        if (chainCtx) {
          wh.sendChainStepDecided({
            callback_url: updated.callback_url,
            hmac_secret: proj.hmac_secret,
            chain_run_id: chainCtx.chain_run_id,
            step_index: chainCtx.step_index,
            review_id: updated.id,
            decision: updated.decision ?? "",
            decided_by: updated.decided_by,
            decided_at: (updated.decided_at ?? new Date()).toISOString(),
            feedback: updated.feedback,
            edited_payload: updated.edited_payload as Record<string, unknown> | null,
            approved_value: updated.approved_value as Record<string, unknown> | null,
            action: {
              id: result.audit.details.action_id as string | undefined,
              label: result.audit.details.action_label as string | undefined,
            },
            request_id: requestId,
          }).catch((err) =>
            console.error("chain.step_decided webhook failed", { review_id: updated.id, err }),
          );
        }
      }
    } else {
      console.error("Webhook skipped: project not found during HMAC lookup", {
        projectId,
        review_id: updated.id,
        request_id: requestId,
      });
    }
  }

  // Internal event bus emits (SSE + notifications + cross-service).
  if (eventBus) {
    const chainCtx = updated.chain_run_id
      ? await resolveChainEventFields(
          db,
          updated.chain_run_id,
          updated.chain_step_id,
        )
      : null;
    const knownEventNames = new Set<string>(NOTIFICATION_EVENTS);
    for (const ev of result.webhooks) {
      if (!knownEventNames.has(ev.event)) continue;
      eventBus.emit(ev.event as NotificationEvent, {
        review_id: updated.id,
        template: updated.template_slug,
        project_id: updated.project_id,
        priority: updated.priority as Priority,
        created_at: updated.created_at.toISOString(),
        ...ev.payload,
        ...(chainCtx ?? {}),
      });
    }
  }

  return updated;
}

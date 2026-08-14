import { z } from "zod";
import {
  PRIORITIES,
  DECISIONS,
  DECISION_VALUES,
  REVIEW_STATUSES,
  DEPRECATED_REVIEW_STATUSES,
  IRREVERSIBILITY,
  TIMEOUT_ACTIONS,
  ACTION_KINDS,
  OVERSIGHT_MODES,
} from "../../enums";

export const PrioritySchema = z.enum(PRIORITIES);
export const DecisionSchema = z.enum(DECISIONS);
export const ReviewStatusSchema = z.enum(REVIEW_STATUSES);
export const OversightSchema = z.enum(OVERSIGHT_MODES);
// Input-tolerant variant for query-param status filtering. Accepts the
// canonical REVIEW_STATUSES values PLUS the deprecated 'changes_requested'
// alias for one minor version per spec §11.3. The route layer's status
// expansion (services/reviews/crud.ts) translates inbound legacy values to
// canonical via inArray(reviews.status, ITERATION_STATUSES). Removed in v2.0.
const ReviewStatusFilterInputSchema = z.enum([
  ...REVIEW_STATUSES,
  ...DEPRECATED_REVIEW_STATUSES,
] as const);
export const IrreversibilitySchema = z.enum(IRREVERSIBILITY);
export const TimeoutActionSchema = z.enum(TIMEOUT_ACTIONS);

const JsonRecord = z.record(z.string(), z.unknown());
const IsoDateString = z.string();

// Assignment ladder (M9 Phase 1). Step statuses follow the lifecycle
// `pending → active → promoted`. Clients may omit `status`; the server
// normalises it on create (index 0 → active, others → pending) and on
// promotion. `trigger_after_seconds` is cumulative from review creation and
// must be strictly increasing across steps (enforced here) so the ladder
// represents a monotonic schedule. Minimum 60s matches the `timeout.seconds`
// minimum used elsewhere in review create.
export const LadderStepStatusSchema = z.enum(["pending", "active", "promoted"]);

export const AssignmentLadderStepSchema = z.object({
  actor: z.string().min(1),
  trigger_after_seconds: z.number().int().min(60),
  status: LadderStepStatusSchema.optional(),
});

export const AssignmentLadderSchema = z
  .array(AssignmentLadderStepSchema)
  .min(1)
  .refine(
    (steps) => {
      for (let i = 1; i < steps.length; i++) {
        if (steps[i].trigger_after_seconds <= steps[i - 1].trigger_after_seconds) {
          return false;
        }
      }
      return true;
    },
    {
      message:
        "assignment_ladder.trigger_after_seconds must be strictly increasing across steps",
    },
  );

// P8 (migration 073): creation-time snapshot of the template field schema.
// Normalized at capture time: editable defaults to false, junk keys stripped.
// Consumers must not assume this matches the live template — it is intentionally
// frozen at the moment the review was created.
export const TemplateFieldSnapshotSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.string(),
  // Optional: migration-073 backfilled rows store raw template fields (may omit editable). Absent === not editable.
  editable: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});

const ReviewTemplateEmbedSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  fields: z
    .array(
      z.object({
        name: z.string(),
        label: z.string(),
        type: z.string(),
        editable: z.boolean().optional(),
        options: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  // Three-shape union mirrors api/schemas/templates.ts TemplateActionsSchema —
  // bare-string presets (legacy v1.0), legacy structured {type,label,value}
  // (v1.1-v1.3), and the canonical configurable-actions arm shipped in Phase
  // 1-3 (v1.4). Inlined locally rather than imported from ./templates to
  // avoid a circular import (templates.ts imports ReviewStatusSchema from
  // this file). Each canonical-arm field MUST stay byte-for-byte identical
  // to TemplateActionConfigSchema in templates.ts; if either union drifts,
  // both must update together. v1.5 carry-forward: extract the canonical
  // arm to a third _action-config.ts module so the duplication can't drift.
  // See spec §11.2 + §3.2 + §7.1 for the canonical shape.
  actions: z
    .array(
      z.union([
        z.string(),
        z.object({ type: z.string(), label: z.string(), value: z.string() }),
        z.object({
          id: z.string().regex(/^[a-z0-9_]+$/, "action id must be slug-format"),
          label: z.string().min(1),
          description: z.string().optional(),
          kind: z.enum(ACTION_KINDS),
          decision_value: z.enum(DECISION_VALUES).optional(),
          webhook_event: z.string().optional(),
          requires_feedback: z.boolean().optional(),
          confirmation: z.boolean().optional(),
          style: z.enum(["primary", "destructive", "secondary", "warning"]).optional(),
          icon: z.string().optional(),
          order: z.number().int().optional(),
          enabled_for_status: z.array(ReviewStatusSchema).optional(),
          expose_to_recipient: z.boolean().optional(),
        }),
      ]),
    )
    .optional(),
  auto_approve: z.boolean().nullable().optional(),
  instructions: z.string().nullable().optional(),
  // Per-template UX gates surfaced to the inbox so ComposeBar can hide the
  // Request Changes button / Notes section per template config.
  allow_request_changes: z.boolean().optional(),
  allow_notes: z.boolean().optional(),
  allow_monitoring: z.boolean().optional(),
  // §3.3 review-link gate. Inbox kebab menu hides the "Generate token link"
  // affordance when this template-level toggle is false. Default true on the
  // column preserves legacy "all templates emit links" behavior.
  enable_review_links: z.boolean().optional(),
});

// Active-token projection — read-only mirror of the latest live row from
// review_tokens for the review. Surfaced on review.get + review.list so the
// Inbox right pane can render token state (recipient, expiry countdown,
// opened/unopened pill) without a follow-up round-trip. Null when no live
// token exists; absent on mutation responses (decide/retry/etc.) which don't
// run the projection. Strict shape matches the ActiveTokenRow type returned
// by the SQL sub-select in services/reviews/crud.ts.
export const ReviewActiveTokenSchema = z.object({
  id: z.string(),
  recipient_label: z.string(),
  auth_level: z.string(),
  created_at: IsoDateString,
  expires_at: IsoDateString,
  opened_at: IsoDateString.nullable(),
});

export const ReviewObjectSchema = z.object({
  object: z.literal("review").optional(),
  id: z.string(),
  project_id: z.string(),
  template_id: z.string().nullable(),
  template_slug: z.string(),
  payload: JsonRecord,
  suggested_value: JsonRecord.nullable().optional(),
  approved_value: JsonRecord.nullable().optional(),
  callback_url: z.string().nullable().optional(),
  priority: PrioritySchema,
  actions: z.array(z.unknown()).optional(),
  status: ReviewStatusSchema,
  // Optional for pre-migration serializer paths and hand-built fixtures;
  // becomes always-present on 201 create responses once the create path
  // writes the column (route-gate task).
  oversight: OversightSchema.optional(),
  // HOTL monitoring gate. expires_at is the veto
  // window deadline — set on all monitoring reviews, null for blocking ones.
  // Nullable+optional for backward compat with pre-monitoring API responses.
  expires_at: IsoDateString.nullable().optional(),
  // reversible | irreversible — set by the agent at create time (spec §4.3).
  // Optional because legacy/blocking reviews may omit this field.
  irreversibility: IrreversibilitySchema.optional(),
  decision: DecisionSchema.nullable(),
  edited_payload: JsonRecord.nullable(),
  feedback: z.string().nullable(),
  decided_by: z.string().nullable(),
  // Whether `decided_by` names someone who was confirmed. FALSE only for a
  // public review link, whose decider is the label the sharer typed and
  // nobody checked. Nullable+optional: rows decided before migration 087 make
  // no claim either way, and a reader must render nothing rather than assume
  // "unverified" for them.
  decided_by_verified: z.boolean().nullable().optional(),
  decided_at: IsoDateString.nullable(),
  current_version: z.number().int().nonnegative(),
  // Derived field: number of revision rounds this review has gone through.
  // Equals current_version - 1. Optional because mutation responses (create,
  // decide, action, etc.) inject it explicitly; read endpoints (list, detail)
  // also inject it at the serialization layer. Never stored — computed on
  // every response from current_version.
  iteration_count: z.number().int().nonnegative().optional(),
  // Whether the "your turn" notification email for this review hard bounced
  // (Task 6/7, notification seam Stage 6 delta). Optional because only
  // GET /reviews/:id and GET /reviews (list) inject it at the serialization
  // layer; mutation responses omit it. An undelivered notification is a
  // correctness bug for an oversight product, so the inbox surfaces it —
  // the list injection is what makes that surfacing actually reach a user
  // (C-1 fix): ReviewRow, the chip's only renderer, is fed exclusively by
  // the list response.
  notification_delivery_failed: z.boolean().optional(),
  assignee: z.string().nullable(),
  metadata: JsonRecord.nullable().optional(),
  draft_payload: JsonRecord.nullable().optional(),
  draft_by: z.string().nullable().optional(),
  draft_at: IsoDateString.nullable().optional(),
  // Human workflow primitives (v1, migration 071). held_by is the human
  // soft-lock — distinct from claimed_by (worker transient lease). Never
  // conflate: held_by is set by a reviewer via the claim route; claimed_by
  // is set by the delivery worker for webhook-delivery concurrency control.
  held_by: z.string().nullable().optional(),
  held_at: IsoDateString.nullable().optional(),
  snoozed_until: IsoDateString.nullable().optional(),
  action_value: z.string().nullable().optional(),
  action_label: z.string().nullable().optional(),
  // Configurable-actions Phase 1 last-action projection (spec §3.3 + §8.3).
  // Backend persists these on every action invocation
  // (services/reviews/execute-action.ts ~217-224) so the inbox can render
  // "Awaiting after '<label>'" captions and decision-history badges
  // without a follow-up audit-log fetch. nullable+optional because:
  // (a) DB column nullable on legacy decided-pre-Phase-1 reviews not yet
  // backfilled, (b) some mutation responses (decide/retry/etc.) might
  // serialize without these fields. Cheap defense-in-depth.
  last_action_id: z.string().nullable().optional(),
  last_action_kind: z.enum(ACTION_KINDS).nullable().optional(),
  last_action_at: IsoDateString.nullable().optional(),
  last_action_by: z.string().nullable().optional(),
  // Assignment ladder surface (M9 Phase 1). The server always returns the
  // normalised ladder (every step carries a concrete `status`), so the embed
  // schema here uses the non-optional status shape — inputs at create-time
  // allow `status` to be omitted and the server fills it in.
  assignment_ladder: z
    .array(
      z.object({
        actor: z.string(),
        trigger_after_seconds: z.number().int(),
        status: LadderStepStatusSchema,
      }),
    )
    .nullable()
    .optional(),
  ladder_index: z.number().int().nonnegative().optional(),
  ladder_next_promote_at: IsoDateString.nullable().optional(),
  // Chain back-pointers (M10). Always present on every review response — null
  // for the 95%+ of reviews not part of a chain. Surfaced so the frontend can
  // gate the chain-context indicator without a second round-trip.
  chain_run_id: z.string().nullable().optional(),
  chain_step_id: z.string().nullable().optional(),
  chain_step_number: z.number().int().positive().nullable().optional(),
  chain_total_steps: z.number().int().positive().nullable().optional(),
  // v1 agent primitives (migration 070).
  // trace_url: optional https-only deep link to the originating agent trace.
  // max_iterations: optional per-review cap on revision rounds.
  trace_url: z.string().nullable().optional(),
  max_iterations: z.number().int().positive().nullable().optional(),
  // P8 (migration 073): creation-time snapshot. Nullish for legacy rows.
  template_fields: TemplateFieldSnapshotSchema.array().nullish(),
  created_at: IsoDateString,
  updated_at: IsoDateString,
  // Always present on every review response (list, detail, mutations). Either the enriched
  // embed or null — never absent. Route layer's `reviewPayload()` helper normalizes the
  // shape for mutation endpoints that don't run a template leftJoin.
  template: ReviewTemplateEmbedSchema.nullable(),
  // Read-side projection from review.get + review.list (sibling of `notes`).
  // Nullable when no live token exists; optional because mutation endpoints
  // (create/decide/retry/etc.) don't run the projection and omit the key.
  active_token: ReviewActiveTokenSchema.nullable().optional(),
});

export const ReviewListQuerySchema = z.object({
  // Input-tolerant: accepts canonical statuses + legacy 'changes_requested'
  // alias per spec §11.3. The route layer translates legacy values to a
  // canonical filter via the ITERATION_STATUSES inArray expansion.
  status: ReviewStatusFilterInputSchema.optional(),
  priority: PrioritySchema.optional(),
  template: z.string().optional(),
  assignee: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const ReviewListResponseSchema = z.object({
  object: z.literal("list"),
  items: z.array(ReviewObjectSchema),
  has_more: z.boolean(),
  total: z.number().int().nonnegative(),
});

export const ReviewCreateBodySchema = z.object({
  template: z.string().min(1),
  payload: JsonRecord,
  callback_url: z.url().optional(),
  priority: PrioritySchema.optional(),
  actions: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  irreversibility: IrreversibilitySchema.optional(),
  // HOTL monitoring gate. Default 'blocking' (absent =
  // blocking) — zero behavior change unless the agent opts in. Monitoring
  // eligibility (reversible-only, template opt-in, callback_url, window)
  // is enforced by the route-layer gate; the schema enforces only the
  // cross-field timeout shape below.
  oversight: OversightSchema.optional(),
  assignee: z.string().optional(),
  metadata: JsonRecord.optional(),
  timeout: z
    .object({
      action: TimeoutActionSchema.optional(),
      seconds: z.number().int().min(60),
    })
    .optional(),
  // Assignment ladder on create. The server owns `ladder_index` and
  // `ladder_next_promote_at`; clients only supply the ordered step list.
  // Step 0 becomes `assignee` and is marked `active`; subsequent steps start
  // `pending` and promote via the TimeoutWorker.
  assignment_ladder: AssignmentLadderSchema.optional(),
  // Idempotency key (migration 069). When supplied, a second POST with the
  // same (project_id, idempotency_key) pair returns the existing review
  // instead of creating a duplicate. Fixes LangGraph node-replay duplicates.
  idempotency_key: z.string().min(1).max(255).optional(),
  // v1 agent primitives (migration 070).
  // trace_url: optional https-only deep link to the originating agent trace.
  // Validated here via refine (authoritative); DB CHECK + route guard are
  // defense-in-depth layers.
  trace_url: z
    .string()
    .refine(
      (u) => { try { return new URL(u).protocol === "https:"; } catch { return false; } },
      { message: "trace_url must be a valid https URL" },
    )
    .optional(),
  // max_iterations: optional per-review cap on revision rounds. Overrides the
  // template-level default when set. Worker auto-closes awaiting_iteration
  // reviews whose current_version - 1 >= max_iterations.
  max_iterations: z.number().int().positive().optional(),
}).superRefine((body, ctx) => {
  const monitoring = body.oversight === "monitoring";
  if (monitoring && body.timeout?.action !== undefined) {
    // timeout_action means "act on silence" — monitoring already acted;
    // silence means auto-confirm. The two semantics cannot share a review.
    ctx.addIssue({
      code: "custom",
      path: ["timeout", "action"],
      message: "timeout.action is not allowed when oversight is 'monitoring'; the window auto-confirms on silence",
    });
  }
  if (!monitoring && body.timeout !== undefined && body.timeout.action === undefined) {
    // Preserve the legacy shape: blocking timeouts always carried an action.
    // A per-review `timeout` therefore owns the whole policy, window AND
    // action — it does not narrow the window while inheriting the template's
    // action. That asymmetry with the chain path (where a step may override
    // timeout_seconds alone and still inherit template.timeout_action) is
    // deliberate-by-inertia rather than by design, and remains unresolved.
    // The message names the inheritance path so a 422 here is a signpost
    // rather than a dead end.
    ctx.addIssue({
      code: "custom",
      path: ["timeout", "action"],
      message: "timeout.action is required when a timeout is supplied. Omit `timeout` entirely to inherit the template's timeout policy.",
    });
  }
});

// Caller-supplied decisions on the legacy /decide alias. Deliberately NOT the
// full DECISIONS enum: `retried`, `expired` and
// `max_iterations_reached` are values the SERVER writes as OUTCOMES, never
// inputs. Accepting them was a silent-approval path, because
// routes/reviews/decide.ts maps every non-'rejected' value to
// action_id='approve' — so `POST /reviews/:id/decide {decision:"expired"}`
// returned 200 with a terminal APPROVAL: approved_value stamped, a
// review.decided webhook telling the agent to execute, and an audit row
// reading `approved` with no trace that the caller asked for something else.
// Echoing a value you just read off a review is the natural integrator
// mistake, and sdk-ts types this field as a bare `string`, so nothing upstream
// stopped it.
//
// `confirmed` / `vetoed` stay admitted here on purpose: the route answers them
// with the actionable `use_monitoring_endpoints` redirect, which is asserted by
// monitoring-guards G1a/G1b and documented in sdk-ts/src/errors.ts. A generic
// enum error would be a worse answer to a reasonable request.
export const ReviewDecideDecisionSchema = z.enum([
  "approved",
  "rejected",
  "edited",
  "confirmed",
  "vetoed",
]);

export const ReviewDecideBodySchema = z.object({
  decision: ReviewDecideDecisionSchema,
  feedback: z.string().optional(),
  edited_payload: JsonRecord.optional(),
  reviewer: z.string().optional(),
  prompt_edit: z.string().optional(),
  version: z.number().int().positive().optional(),
  action_value: z.string().optional(),
  action_label: z.string().optional(),
});

// HOTL monitoring gate. Veto accepts an optional note — under the locked
// notify-only contract this note is the only context the agent gets for the
// undo. Stored in reviews.feedback, carried in the review.vetoed webhook
// payload and the audit detail. Confirm-now takes no body.
// 10k cap (vs 1k chain notes): a veto note is operational undo context for
// the agent and may need multi-paragraph detail.
export const ReviewVetoBodySchema = z.object({
  note: z.string().min(1).max(10_000).optional(),
});
export type ReviewVetoBody = z.infer<typeof ReviewVetoBodySchema>;

export const ReviewRetryBodySchema = z.object({
  feedback: z.string().min(1),
  prompt_edit: z.string().optional(),
});

// Configurable-actions primitive (spec §3.1). Single body shape for all
// action invocations — decision, iteration, side_effect kinds — replacing
// the per-endpoint /decide /retry /cancel-request shapes during the v1.4 →
// v1.5 transition.
export const ReviewActionBodySchema = z.object({
  action_id: z.string().min(1),
  feedback: z.string().optional(),
  edited_payload: JsonRecord.optional(),
  version: z.number().int().positive().optional(),
});

export const ReviewUpdateVersionBodySchema = z.object({
  payload: JsonRecord,
  version: z.number().int().positive(),
});

export const ReviewDraftBodySchema = z.object({
  draft_payload: JsonRecord,
});

export const ReviewBulkIdsBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const ReviewNoteBodySchema = z.object({
  content: z.string().min(1),
});

// Human workflow primitives (v1). Assign: admin reassigns a review to a
// specific reviewer; hold flag optionally sets held_by to the new assignee.
// Snooze: set or clear snoozed_until; null clears an existing snooze.
export const ReviewAssignBodySchema = z.object({
  assignee: z.string().min(1),
  hold: z.boolean().optional().default(false),
});

export const ReviewSnoozeBodySchema = z.object({
  until: z.string().datetime().nullable(),
});

export const ReviewTokenBodySchema = z.object({
  expiryHours: z.coerce.number().positive().optional(),
});

// Token-history-panel. Read-only projection of review_tokens rows for the
// v1.4 history panel.
// `status` is a derived label, not stored — see services/review-tokens.ts
// deriveTokenStatus(). Precedence: revoked > used > expired > active.
export const TokenHistoryRowSchema = z.object({
  id: z.string(),
  recipient_label: z.string(),
  auth_level: z.enum(["public", "email_otp", "account"]),
  purpose: z.string(),
  note: z.string().nullable(),
  created_at: IsoDateString,
  expires_at: IsoDateString,
  used_at: IsoDateString.nullable(),
  revoked_at: IsoDateString.nullable(),
  revoked_by: z.string().nullable(),
  opened_at: IsoDateString.nullable(),
  decided_by_email: z.string().nullable(),
  decided_by_user_id: z.string().nullable(),
  decision: z.string().nullable(),
  status: z.enum([
    "active",
    "approved",
    "rejected",
    "declined",
    "expired",
    "revoked",
    "completed",
  ]),
});

export const ListReviewTokensResponseSchema = z.object({
  items: z.array(TokenHistoryRowSchema),
  total: z.number().int().nonnegative(),
  has_more: z.boolean(),
});

export const ExpiredTokenSummaryResponseSchema = z
  .object({
    count: z.number().int().nonnegative(),
    sample_review_ids: z.array(z.string()).max(5),
  })
  .refine(
    (v) => v.count > 0 || v.sample_review_ids.length === 0,
    { message: "sample_review_ids must be empty when count is 0" },
  );
export type ExpiredTokenSummaryResponse = z.infer<typeof ExpiredTokenSummaryResponseSchema>;

export type ReviewObject = z.infer<typeof ReviewObjectSchema>;
export type ReviewListQuery = z.infer<typeof ReviewListQuerySchema>;
export type ReviewListResponse = z.infer<typeof ReviewListResponseSchema>;
export type ReviewCreateBody = z.infer<typeof ReviewCreateBodySchema>;
export type ReviewDecideBody = z.infer<typeof ReviewDecideBodySchema>;
export type ReviewRetryBody = z.infer<typeof ReviewRetryBodySchema>;
export type ReviewActionBody = z.infer<typeof ReviewActionBodySchema>;
export type ReviewUpdateVersionBody = z.infer<typeof ReviewUpdateVersionBodySchema>;
export type ReviewDraftBody = z.infer<typeof ReviewDraftBodySchema>;
export type ReviewBulkIdsBody = z.infer<typeof ReviewBulkIdsBodySchema>;
export type ReviewNoteBody = z.infer<typeof ReviewNoteBodySchema>;
export type ReviewTokenBody = z.infer<typeof ReviewTokenBodySchema>;
export type ReviewAssignBody = z.infer<typeof ReviewAssignBodySchema>;
export type ReviewSnoozeBody = z.infer<typeof ReviewSnoozeBodySchema>;
export type TokenHistoryRow = z.infer<typeof TokenHistoryRowSchema>;
export type ListReviewTokensResponse = z.infer<typeof ListReviewTokensResponseSchema>;
export type LadderStepStatus = z.infer<typeof LadderStepStatusSchema>;
export type AssignmentLadderStep = z.infer<typeof AssignmentLadderStepSchema>;
export type AssignmentLadder = z.infer<typeof AssignmentLadderSchema>;
export type ReviewActiveToken = z.infer<typeof ReviewActiveTokenSchema>;

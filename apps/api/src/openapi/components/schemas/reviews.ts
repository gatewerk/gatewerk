// Review-domain schemas — request bodies, the Review resource, and its
// list/version/token wrappers.
//
// Owns these enum registrations on the central OpenAPIRegistry:
//   Priority, Decision, Irreversibility, ReviewStatus, TimeoutAction,
//   JsonObject. Do not re-register these names elsewhere — the registry
//   throws on duplicate names.
//
// Owns these review-domain schema registrations:
//   ReviewCreateBody, ReviewDecideBody, ReviewActionBody, BulkIdsBody, Review,
//   ReviewList, ReviewVersion, ReviewToken, TokenHistoryRow, ListReviewTokensResponse.

import { z } from "zod";
import { registry } from "../../registry";
import { TemplateFieldSchema } from "./shared";
import { constLiteral } from "./_helpers";

// --- Leaf / shared types ---

export const PrioritySchema = registry.register(
  "Priority",
  z.enum(["low", "normal", "high", "critical"]),
);

// Canonical decision set, mirrors DECISIONS in @gatewerk/shared and the
// reviews_decision_chk DB constraint. `declined` is NOT included — that value
// lives only on review_tokens.decision (TokenHistoryRow.decision), surfaced as
// plain z.string().nullable() because the projection composes a derived
// status that may also include action-config labels.
export const DecisionSchema = registry.register(
  "Decision",
  z.enum(["approved", "rejected", "edited", "retried", "expired"]),
);

export const IrreversibilitySchema = registry.register(
  "Irreversibility",
  z.enum(["reversible", "costly_reversible", "irreversible"]),
);

export const ReviewStatusSchema = registry.register(
  "ReviewStatus",
  z
    .enum(["pending", "awaiting_iteration", "decided", "expired", "archived"])
    .openapi({
      description:
        "Canonical review status. Wire-format output is always one of these " +
        "five values. Query-param status filter additionally accepts the " +
        "legacy 'changes_requested' alias as a deprecated input for one " +
        "minor version per spec §11.3 — removed in v2.0.",
    }),
);

export const TimeoutActionSchema = registry.register(
  "TimeoutAction",
  z.enum(["auto_approve", "auto_reject", "expire"]),
);

export const JsonObjectSchema = registry.register(
  "JsonObject",
  z.record(z.string(), z.unknown()).openapi({
    description: "Free-form JSON object.",
    additionalProperties: true,
  }),
);

// --- Oversight / assignment-ladder leaf schemas ---

// Mirror of OversightSchema in packages/shared/src/api/schemas/reviews.ts.
// Keep in sync with OVERSIGHT_MODES enum in packages/shared/src/enums.ts.
export const OversightSchema = registry.register(
  "Oversight",
  z.enum(["blocking", "monitoring"]).openapi({
    description:
      "Oversight mode for the review. 'blocking' (default) pauses the agent " +
      "until a human decides. 'monitoring' records the action and auto-confirms " +
      "after the veto window; the human can veto before the window closes.",
  }),
);

// Mirror of AssignmentLadderStepSchema in packages/shared/src/api/schemas/reviews.ts.
export const AssignmentLadderStepSchema = registry.register(
  "AssignmentLadderStep",
  z.object({
    actor: z.string().min(1).openapi({ description: "Assignee email or role identifier." }),
    trigger_after_seconds: z.number().int().min(60).openapi({
      description:
        "Seconds from review creation after which this step becomes active. " +
        "Must be strictly increasing across steps.",
    }),
    status: z.enum(["pending", "active", "promoted"]).optional().openapi({
      description: "Step lifecycle status. Server normalises on create; clients may omit.",
    }),
  }),
);

// Mirror of AssignmentLadderSchema in packages/shared/src/api/schemas/reviews.ts.
// Strictly-increasing trigger_after_seconds is enforced by the canonical Zod
// .refine in the shared schema; the OpenAPI description documents the invariant
// for API consumers.
export const AssignmentLadderSchema = registry.register(
  "AssignmentLadder",
  z.array(AssignmentLadderStepSchema).min(1).openapi({
    description:
      "Ordered escalation ladder. Step 0 becomes the initial assignee; " +
      "subsequent steps activate when trigger_after_seconds elapses. " +
      "trigger_after_seconds must be strictly increasing across steps.",
  }),
);

// --- Request bodies ---

// Mirror of ReviewCreateBodySchema in packages/shared/src/api/schemas/reviews.ts.
// Keep fields + shapes in sync with the canonical runtime validator there.
export const ReviewCreateBodySchema = registry.register(
  "ReviewCreateBody",
  z.object({
    template: z.string().min(1).openapi({ description: "Template slug." }),
    payload: JsonObjectSchema,
    callback_url: z
      .string()
      .url()
      .optional()
      .openapi({
        description:
          "HTTPS URL to receive decision webhooks. Validated against SSRF " +
          "rules (no private IPs). Omit to poll instead.",
      }),
    priority: PrioritySchema.optional(),
    actions: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    irreversibility: IrreversibilitySchema.optional(),
    assignee: z.string().optional(),
    metadata: JsonObjectSchema.optional(),
    timeout: z
      .object({
        action: TimeoutActionSchema,
        seconds: z.number().int().min(60),
      })
      .optional()
      .openapi({
        description: "Override the template's timeout policy for this review.",
      }),
    // Fields below were missing from OpenAPI but accepted by the runtime validator.
    oversight: OversightSchema.optional(),
    assignment_ladder: AssignmentLadderSchema.optional().openapi({
      description:
        "Escalation ladder for the review. Step 0 becomes the initial assignee; " +
        "subsequent steps activate after trigger_after_seconds. Omit to use " +
        "the template default or the assignee field.",
    }),
    idempotency_key: z.string().min(1).max(255).optional().openapi({
      description:
        "Client-supplied deduplication key. A second POST with the same " +
        "(project, idempotency_key) pair returns the existing review instead " +
        "of creating a duplicate. Terminal conflict (decided/expired review) " +
        "returns 409 idempotency_key_terminal_conflict.",
    }),
    trace_url: z
      .string()
      .refine(
        (u) => { try { return new URL(u).protocol === "https:"; } catch { return false; } },
        { message: "trace_url must be a valid https URL" },
      )
      .optional()
      .openapi({
        description:
          "Optional deep link to the originating agent trace. Must be https.",
      }),
    max_iterations: z.number().int().positive().optional().openapi({
      description:
        "Per-review cap on revision rounds. Overrides the template-level " +
        "default. Worker auto-closes awaiting_iteration reviews whose " +
        "current_version - 1 >= max_iterations.",
    }),
  }),
);

export const ReviewDecideBodySchema = registry.register(
  "ReviewDecideBody",
  z.object({
    decision: DecisionSchema,
    feedback: z.string().optional(),
    edited_payload: JsonObjectSchema.optional(),
    reviewer: z.string().optional().openapi({
      description: "Identifier of the human deciding. Auto-filled from session.",
    }),
    prompt_edit: z.string().optional(),
    version: z.number().int().min(1).optional(),
    action_value: z.string().optional(),
    action_label: z.string().optional(),
  }),
);

// Mirror of the canonical validator in packages/shared/src/api/schemas/reviews.ts (ReviewActionBodySchema); keep action_id semantics + fields in sync.
export const ReviewActionBodySchema = registry.register(
  "ReviewActionBody",
  z.object({
    action_id: z.string().min(1).openapi({
      description:
        "Preset action identifier. Built-in values: `approve`, `reject`, " +
        "`request_changes`, `cancel_iteration`. Custom actions are defined " +
        "on the template.",
    }),
    feedback: z.string().optional(),
    edited_payload: JsonObjectSchema.optional(),
    version: z.number().int().min(1).optional(),
  }),
);

export const BulkIdsBodySchema = registry.register(
  "BulkIdsBody",
  z.object({
    ids: z.array(z.string().min(1)).min(1),
  }),
);

// --- Resource schemas ---

export const ReviewSchema = registry.register(
  "Review",
  z.object({
    object: z.literal("review").openapi(constLiteral("review")),
    id: z.string(),
    project_id: z.string(),
    template_id: z.string().nullable().optional(),
    template_slug: z.string(),
    payload: JsonObjectSchema,
    // z.union([SchemaRef, z.null()]) emits oneOf:[$ref, {type:"null"}]; preferred
    // over SchemaRef.nullable() which can produce a Zod allOf form that this
    // document does not consume.
    suggested_value: z.union([JsonObjectSchema, z.null()]).optional(),
    approved_value: z.union([JsonObjectSchema, z.null()]).optional(),
    edited_payload: z.union([JsonObjectSchema, z.null()]).optional(),
    callback_url: z.string().nullable().optional(),
    priority: PrioritySchema,
    actions: z.array(z.unknown()).optional(), // typed as unknown to match the hand-authored shape; tighten when actions[] surface stabilizes
    status: ReviewStatusSchema,
    decision: z.union([DecisionSchema, z.null()]).optional(),
    feedback: z.string().nullable().optional(),
    decided_by: z.string().nullable().optional(),
    decided_by_verified: z.boolean().nullable().optional().openapi({
      description:
        "Whether decided_by names a confirmed identity. False only for a decision made through a PUBLIC review link, where the decider is the recipient_label the sharer typed and nothing verified it. Null for reviews decided before this field existed: render no claim rather than assuming unverified.",
    }),
    decided_at: z.string().datetime().nullable().optional(),
    current_version: z.number().int().min(0),
    assignee: z.string().nullable().optional(),
    metadata: z.union([JsonObjectSchema, z.null()]).optional(),
    action_value: z.string().nullable().optional(),
    action_label: z.string().nullable().optional(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    template: z
      .object({
        name: z.string().optional(),
        fields: z.array(TemplateFieldSchema).optional(),
        actions: z.array(z.unknown()).optional(), // typed as unknown to match the hand-authored shape; tighten when actions[] surface stabilizes
        auto_approve: z.boolean().nullable().optional(),
        instructions: z.string().nullable().optional(),
        enable_review_links: z.boolean().optional().openapi({
          description:
            "Per-template toggle gating the Inbox kebab `Generate token link` affordance.",
        }),
      })
      .optional()
      .openapi({
        description: "Embedded snapshot of the template used at creation time.",
      }),
    // P8 (migration 073): creation-time snapshot. Null for legacy rows.
    template_fields: z.array(TemplateFieldSchema).nullable().optional().openapi({
      description:
        "Normalized field schema captured at review creation. " +
        "Frozen — template re-publish or deletion does not affect this value. " +
        "Null for reviews created before migration 073.",
    }),
    active_token: z
      .union([
        z.object({
          id: z.string(),
          recipient_label: z.string(),
          auth_level: z.string(),
          created_at: z.string().datetime(),
          expires_at: z.string().datetime(),
          opened_at: z.string().datetime().nullable().optional(),
        }),
        z.null(),
      ])
      .optional()
      .openapi({
        description:
          "Latest live (un-used, un-revoked, un-expired) review_tokens row, " +
          "projected read-only on review.get and review.list. Null when no " +
          "live token exists. Absent on mutation responses (create/decide/ " +
          "retry/etc.) which don't run the projection.",
      }),
  }),
);

export const ReviewListSchema = registry.register(
  "ReviewList",
  z.object({
    object: z.literal("list").openapi(constLiteral("list")),
    items: z.array(ReviewSchema),
    has_more: z.boolean(),
    total: z.number().int().min(0).optional(),
  }),
);

export const ReviewVersionSchema = registry.register(
  "ReviewVersion",
  z.object({
    id: z.string(),
    review_id: z.string(),
    version: z.number().int().min(1),
    payload: JsonObjectSchema,
    created_at: z.string().datetime(),
  }),
);

export const ReviewTokenSchema = registry.register(
  "ReviewToken",
  z.object({
    object: z.literal("review_token").openapi(constLiteral("review_token")),
    token: z.string().openapi({
      description: "Raw token. Returned once — store it client-side.",
    }),
    review_id: z.string(),
    expires_at: z.string().datetime().nullable().optional(),
    url: z.string().openapi({
      description:
        "Path component (e.g. `/r/{token}`). Prefix with your UI origin.",
    }),
  }),
);

export const TokenHistoryRowSchema = registry.register(
  "TokenHistoryRow",
  z
    .object({
      id: z.string(),
      recipient_label: z.string(),
      auth_level: z.enum(["public", "email_otp", "account"]),
      purpose: z.string(),
      note: z.string().nullable(),
      created_at: z.string().datetime(),
      expires_at: z.string().datetime(),
      used_at: z.string().datetime().nullable(),
      revoked_at: z.string().datetime().nullable(),
      revoked_by: z.string().nullable(),
      opened_at: z.string().datetime().nullable(),
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
    })
    .openapi({
      description:
        "Read-only projection of a single review_tokens row. `status` is " +
        "derived (revoked > used > expired > active). The decision label " +
        "rolls up: approved/rejected/declined surface verbatim, anything else " +
        "becomes 'completed' (forward-compat for configurable-actions labels).",
    }),
);

export const ListReviewTokensResponseSchema = registry.register(
  "ListReviewTokensResponse",
  z.object({
    items: z.array(TokenHistoryRowSchema),
    total: z.number().int().min(0),
    has_more: z.boolean(),
  }),
);

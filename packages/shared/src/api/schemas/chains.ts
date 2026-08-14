import { z } from "zod";
import { PRIORITIES } from "../../enums";

// Chain definition v1.0 Zod schema (M10 Phase 1).
//
// Maps the chain-definition-format spec §3-§5 into runtime validation.
// V1–V19 in §9 are enforced here except for:
//   * V15 (dependency cycle): sequential mode has no cycles by construction;
//     when Cloud lands and accepts non-sequential modes, a topological-sort
//     refinement will gate V15 on those mode values.
//   * V17–V19 (parallel_groups shape): these only apply when mode is
//     parallel/mixed, which this schema rejects outright under OSS via V13
//     (feature_not_in_edition). The parallel_groups surface is therefore
//     unspecified here; Cloud adds it in a separate schema layer.
//
// Error shape: we lean on zod's default error construction for shape-level
// problems (type mismatches, regex failures, min/max). Cross-cutting rules
// that a flat zod type can't express (unique step IDs, V8 "assignee exists",
// V13 OSS edition gating, V14 depends_on references) live in `superRefine`.
// All refinement errors carry `params.code` set to the documented error
// identifier so the API error handler can surface it verbatim.

const StepIdRegex = /^[a-z0-9_-]{1,64}$/;

// `user` assignee — note: `at least one of email/user_id` is enforced at the
// outer superRefine rather than via .refine() here. Zod's discriminatedUnion
// rejects ZodEffects variants, so the refinement has to live upstream.
const UserAssigneeSchema = z.object({
  kind: z.literal("user"),
  email: z.email().optional(),
  user_id: z.string().min(1).optional(),
});

const RoleAssigneeSchema = z.object({
  kind: z.literal("role"),
  role: z.enum(["admin", "reviewer"]),
});

const ExternalTokenAssigneeSchema = z.object({
  kind: z.literal("external_token"),
  expires_in_seconds: z.number().int().min(3600).max(2592000).optional(),
  grace_period_seconds: z.number().int().min(0).max(86400).optional(),
  note: z.string().max(1000).optional(),
  // Auth-tier integration (§13). Cross-field invariant
  // `(auth_level, auth_email, auth_user_id)` enforced at the chain-level
  // superRefine below. Mirrors the manual route gate in
  // apps/api/src/routes/reviews/tokens.ts ShareViaLinkDialog wire schema.
  // Five stable error codes are reused VERBATIM so SDK callers can branch
  // on `params.code` identically across manual + chain creation paths.
  //
  // 5th preventive member of the project-level invariant-pair-mutation
  // family. Helper-layer
  // defense-in-depth lives in apps/api/src/services/review-tokens.ts so
  // ALL future bypass paths (raw service calls, future bulk endpoints,
  // SDK callers) are caught.
  auth_level: z.enum(["public", "email_otp", "account"]).optional(),
  auth_email: z.email().max(254).optional().nullable(),
  auth_user_id: z.string().max(64).optional().nullable(),
  recipient_label: z.string().min(1).max(200).optional(),
  purpose: z.string().min(1).max(80).optional(),
});

export const AssigneeSpecSchema = z.discriminatedUnion("kind", [
  UserAssigneeSchema,
  RoleAssigneeSchema,
  ExternalTokenAssigneeSchema,
]);

// M13 per-step rejection disposition. `abort` preserves the M10 terminate
// semantics (chain ends), `continue` treats rejection as "skip and move on",
// `branch` jumps back to an earlier step (`rejection_branch_to`, 1-based
// step_number). Absence of the field defaults to 'abort' at the engine layer.
export const StepRejectionPolicySchema = z.enum(["abort", "continue", "branch"]);

export const ChainDefinitionStepSchema = z.object({
  id: z.string().regex(StepIdRegex, {
    message: "step.id must match /^[a-z0-9_-]{1,64}$/",
  }),
  name: z.string().optional(),
  description: z.string().optional(),
  // C1 (route model): RETIRED. A chain resolves ONE entry template and every
  // step reviews the same request against it, so a step no longer names a
  // template of its own. Kept here, optional and ignored by the engine, for
  // two reasons: `ChainAxis` is type-derived from this schema, so deleting the
  // key breaks the audit:surface gate; and this object is non-strict while
  // validate.ts replaces the request body with the parse result, so a legacy
  // chain_config would have the field stripped on its first save regardless.
  // A definition with no envelope template falls back to steps[0].template.
  template: z.string().min(1).optional(),
  assignee: AssigneeSpecSchema,
  timeout_seconds: z.number().int().min(60).optional(),
  priority: z.enum(PRIORITIES).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  depends_on: z.array(z.string()).optional(),
  // M13: per-step rejection policy + branch target. Cycle-avoidance
  // (branch target must precede the current step) is refined at the chain
  // level below because it needs the step's 1-based position.
  rejection_policy: StepRejectionPolicySchema.optional(),
  rejection_branch_to: z.number().int().positive().optional(),
  // Cloud-only fields; presence is rejected via superRefine below. Schema
  // accepts them syntactically so the error layer can name them precisely.
  parallel_group: z.string().optional(),
  condition: z.record(z.string(), z.unknown()).optional(),
});

export const RejectionPolicySchema = z.enum(["terminate", "back_one", "restart"]);

export const ChainModeSchema = z.enum(["sequential", "parallel", "mixed"]);

export const MAX_CHAIN_STEPS_OSS = 20;

export const ChainDefinitionSchema = z
  .object({
    version: z.literal("1.0"),
    name: z.string().optional(),
    description: z.string().optional(),
    // C1: the entry template. One request, one payload, one form — every step
    // of the route materialises a review against THIS template. Optional on
    // the envelope because a template's own `chain_config` does not repeat the
    // template it hangs off (the route is that template's property); the
    // POST /chain-runs route, which has no owning template, requires it.
    template: z.string().min(1).optional(),
    mode: ChainModeSchema,
    rejection_policy: RejectionPolicySchema.default("terminate"),
    metadata: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(ChainDefinitionStepSchema).min(1),
    // Cloud-only top-level surface. Presence triggers V13.
    parallel_groups: z.record(z.string(), z.unknown()).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((def, ctx) => {
    // V13 — OSS edition gating. Reject cloud-only shapes before any other
    // refinement so the error message is unambiguous.
    if (def.mode !== "sequential") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mode"],
        message: `mode '${def.mode}' is not supported in this edition`,
        params: { code: "feature_not_in_edition" },
      });
    }
    if (def.parallel_groups !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parallel_groups"],
        message: "parallel_groups is not supported in this edition",
        params: { code: "feature_not_in_edition" },
      });
    }
    for (let i = 0; i < def.steps.length; i++) {
      const step = def.steps[i];
      if (step.parallel_group !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "parallel_group"],
          message: "step.parallel_group is not supported in this edition",
          params: { code: "feature_not_in_edition" },
        });
      }
      if (step.condition !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "condition"],
          message: "step.condition is not supported in this edition",
          params: { code: "feature_not_in_edition" },
        });
      }
    }

    // V5 — duplicate step ids.
    const seen = new Set<string>();
    for (let i = 0; i < def.steps.length; i++) {
      const id = def.steps[i].id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "id"],
          message: `duplicate step.id '${id}'`,
          params: { code: "duplicate_step_id" },
        });
      }
      seen.add(id);
    }

    // V14 — depends_on references must resolve within the same chain.
    const ids = new Set(def.steps.map((s) => s.id));
    for (let i = 0; i < def.steps.length; i++) {
      const deps = def.steps[i].depends_on || [];
      for (const dep of deps) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", i, "depends_on"],
            message: `depends_on references unknown step '${dep}'`,
            params: { code: "unknown_depends_on" },
          });
        }
      }
    }

    // V8 — user assignee requires at least one of email/user_id. Lives
    // here because the discriminatedUnion can't accept a ZodEffects variant.
    for (let i = 0; i < def.steps.length; i++) {
      const a = def.steps[i].assignee;
      if (a.kind === "user" && !a.email && !a.user_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "assignee"],
          message: "user assignee requires at least one of email, user_id",
          params: { code: "assignee_user_missing_ref" },
        });
      }
    }

    // V13b — OSS edition gate: auth_level='account' on external_token steps is
    // a Cloud-only feature. NOTE: this schema is shared across editions and
    // currently has NO Cloud override, so V13b (like V13) fires in ALL editions
    // today. Account-tier Cloud chains are not a shipping feature yet; when they
    // ship, both V13 and V13b need a real edition conditional here.
    //
    // Back-compat: only fires when auth_level is EXPLICITLY set on the step
    // assignee. A template with `default_auth_level='account'` and NO explicit
    // assignee `auth_level` does NOT trip V13b — the auth_level is resolved at
    // materialisation time from the template default, which is a Cloud
    // operator configuration concern handled outside this schema layer.
    for (let i = 0; i < def.steps.length; i++) {
      const a = def.steps[i].assignee;
      if (a.kind !== "external_token") continue;
      if (a.auth_level === "account") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "assignee", "auth_level"],
          message: "auth_level 'account' is not supported in this edition",
          params: { code: "feature_not_in_edition" },
        });
      }
    }

    // External_token cross-field auth-tier gate (§13). Identical 5 stable
    // error codes to the manual-token route. SDK callers can branch on
    // params.code uniformly across manual + chain creation paths.
    //
    // Only fires when auth_level is explicitly set on the assignee — the
    // common back-compat case (no auth_level → defaults to template default
    // / "public" at materialisation time) carries no contextual fields and
    // bypasses these checks entirely.
    for (let i = 0; i < def.steps.length; i++) {
      const a = def.steps[i].assignee;
      if (a.kind !== "external_token") continue;
      if (a.auth_level === undefined) continue;

      if (a.auth_level === "public" && a.auth_email) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "assignee", "auth_email"],
          message: "auth_email must be null when auth_level is public",
          params: { code: "auth_level.contextual_fields_not_allowed_for_public" },
        });
      }
      if (a.auth_level === "public" && a.auth_user_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "assignee", "auth_user_id"],
          message: "auth_user_id must be null when auth_level is public",
          params: { code: "auth_level.contextual_fields_not_allowed_for_public" },
        });
      }
      if (a.auth_level === "email_otp" && !a.auth_email) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "assignee", "auth_email"],
          message: "auth_email required when auth_level is email_otp",
          params: { code: "auth_level.email_required" },
        });
      }
      if (a.auth_level === "email_otp" && a.auth_user_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "assignee", "auth_user_id"],
          message: "auth_user_id must be null when auth_level is email_otp",
          params: { code: "auth_level.user_id_not_allowed_for_email_otp" },
        });
      }
      if (a.auth_level === "account" && !a.auth_user_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "assignee", "auth_user_id"],
          message: "auth_user_id required when auth_level is account",
          params: { code: "auth_level.user_id_required" },
        });
      }
      if (a.auth_level === "account" && a.auth_email) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "assignee", "auth_email"],
          message: "auth_email must be null when auth_level is account",
          params: { code: "auth_level.email_not_allowed_for_account" },
        });
      }
    }

    // V16 — OSS hard cap on step count.
    if (def.steps.length > MAX_CHAIN_STEPS_OSS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps"],
        message: `too many steps (max ${MAX_CHAIN_STEPS_OSS})`,
        params: { code: "too_many_steps" },
      });
    }

    // M13 per-step rejection policy refinements:
    //   * `branch` MUST ship `rejection_branch_to`; other policies MUST NOT
    //     (prevents the "stray field" mis-authoring where a later edit
    //     changes the policy but leaves the branch target behind).
    //   * `rejection_branch_to` MUST reference a 1-based step_number that
    //     precedes the current step — guarantees no cycles at DAG level.
    //     The DB CHECK in migration 023 enforces the same invariant.
    for (let i = 0; i < def.steps.length; i++) {
      const step = def.steps[i];
      const stepNumber = i + 1; // 1-based, matches chain_steps.step_number
      const policy = step.rejection_policy;
      const branchTo = step.rejection_branch_to;

      if (policy === "branch") {
        if (branchTo === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", i, "rejection_branch_to"],
            message: "rejection_branch_to is required when rejection_policy='branch'",
            params: { code: "rejection_branch_to_missing" },
          });
        } else if (branchTo >= stepNumber) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", i, "rejection_branch_to"],
            message: `rejection_branch_to (${branchTo}) must be less than the step's position (${stepNumber}) to avoid cycles`,
            params: { code: "rejection_branch_to_cycle" },
          });
        }
      } else if (branchTo !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "rejection_branch_to"],
          message: "rejection_branch_to is only valid when rejection_policy='branch'",
          params: { code: "rejection_branch_to_misplaced" },
        });
      }
    }
  });

export const ChainRunCreateBodySchema = z.object({
  definition: ChainDefinitionSchema,
  initial_payload: z.record(z.string(), z.unknown()),
  callback_url: z.url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// Lifecycle of the active token attached to an external_token step (§13).
// Mirrors the precedence in apps/api/src/services/review-tokens.ts
// `deriveTokenStatus` (revoked > used_at outcome > expired > active).
// Optional + nullable so the chain envelope shape stays back-compat for
// callers on older API versions.
//
// `deriveTokenStatus` never emits the literal "used"; the consume path
// resolves to a decision-shaped status (approved / rejected / declined /
// completed). The "used" enum value was speculative dead code in the
// initial §13 wire and has been removed (I5 cross-agent convergence).
//
// PII-as-type-absence: this type intentionally omits any field that could
// carry recipient PII. The chain envelope projection MUST NOT surface
// auth_email or auth_user_id. auth_level is operator-set and safe to
// surface (added on the assignee_spec, not here).
export const ChainStepTokenStatusSchema = z.enum([
  "active",
  "approved",
  "rejected",
  "declined",
  "completed",
  "expired",
  "revoked",
]);

export const ChainStepObjectSchema = z.object({
  object: z.literal("chain_step").optional(),
  id: z.string(),
  chain_run_id: z.string(),
  step_number: z.number().int().positive(),
  review_id: z.string().nullable(),
  assignee_spec: z.record(z.string(), z.unknown()),
  depends_on: z.array(z.string()).nullable(),
  status: z.enum(["pending", "active", "approved", "rejected", "expired", "skipped", "superseded"]),
  materialized_at: z.string().nullable(),
  rejection_policy: StepRejectionPolicySchema.nullable().optional(),
  rejection_branch_to: z.number().int().positive().nullable().optional(),
  // Token lifecycle for external_token steps (§13). null/undefined when
  // the step assignee is not external_token, or when no token has been
  // generated yet (e.g. a pending step that hasn't materialised).
  token_status: ChainStepTokenStatusSchema.nullable().optional(),
  // C1 relay (charter §3): what this step's reviewer decided, so the NEXT
  // reviewer can state it without leaving their own review. Populated only for
  // a step whose review reached a terminal state — an in-flight draft is not a
  // judgment, and showing one as though it were would be worse than silence.
  decision: z.string().nullable().optional(),
  decided_by: z.string().nullable().optional(),
  decided_at: z.string().nullable().optional(),
  feedback: z.string().nullable().optional(),
  // The step's guidance: one line telling that reviewer what to weigh. Lives
  // inside the step definition (`description`), projected onto the step object
  // because chain_steps has no column for it.
  guidance: z.string().nullable().optional(),
});

export const ChainRunObjectSchema = z.object({
  object: z.literal("chain_run").optional(),
  id: z.string(),
  project_id: z.string(),
  template_id: z.string().nullable(),
  name: z.string().nullable(),
  mode: z.string(),
  rejection_policy: z.string(),
  status: z.enum(["active", "completed", "rejected", "aborted"]),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  created_by: z.string(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
  steps: z.array(ChainStepObjectSchema).optional(),
});

export type ChainDefinition = z.infer<typeof ChainDefinitionSchema>;
export type ChainDefinitionStep = z.infer<typeof ChainDefinitionStepSchema>;
export type AssigneeSpec = z.infer<typeof AssigneeSpecSchema>;
export type RejectionPolicy = z.infer<typeof RejectionPolicySchema>;
export type StepRejectionPolicy = z.infer<typeof StepRejectionPolicySchema>;
export type ChainMode = z.infer<typeof ChainModeSchema>;
export type ChainRunCreateBody = z.infer<typeof ChainRunCreateBodySchema>;
export type ChainRunObject = z.infer<typeof ChainRunObjectSchema>;
export type ChainStepObject = z.infer<typeof ChainStepObjectSchema>;
export type ChainStepTokenStatus = z.infer<typeof ChainStepTokenStatusSchema>;

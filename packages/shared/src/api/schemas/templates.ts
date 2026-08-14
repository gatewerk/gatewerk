import { z } from "zod";
import {
  PRIORITIES,
  FIELD_TYPES,
  TIMEOUT_ACTIONS,
  ACTION_KINDS,
  DECISION_VALUES,
} from "../../enums";
import { ChainDefinitionSchema } from "./chains";
import { ReviewStatusSchema } from "./reviews";

// Token expiry contract — single source of truth across web + api + DB.
// MAX matches migration 039 CHECK; TEMPLATE_DEFAULT matches DB DEFAULT;
// MIN is the lowest valid integer second-count. Imported by editor helpers,
// the share dialog state module, and the Zod range below so a single edit
// here propagates everywhere.
export const TOKEN_EXPIRY_SECONDS = {
  MIN: 1,
  MAX: 2592000, // 30 days
  TEMPLATE_DEFAULT: 86400, // 24h
} as const;

const TEMPLATE_STATUSES = ["draft", "active", "inactive"] as const;
// Legacy preset action ids — kept exported for back-compat during the
// configurable-actions Phase 1 → 5 transition. New action authoring uses
// the structured TemplateActionConfigSchema below; these constants identify
// the three default presets the system ships (DEFAULT_ACTION_PRESETS).
const ACTION_TYPES = ["approve", "reject", "request_changes"] as const;

export const TemplateStatusSchema = z.enum(TEMPLATE_STATUSES);
export const TemplateActionTypeSchema = z.enum(ACTION_TYPES);
export const FieldTypeSchema = z.enum(FIELD_TYPES);

const IsoDateString = z.string();

// slug: lowercase alphanumeric with hyphens; must start and end alphanumeric.
const SlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric with hyphens");

// TemplateField.name flows directly into uploaded-media filenames in
// `apps/api/src/services/media.ts` (`${fieldName}${ext}` joined under
// UPLOADS_DIR/<reviewId>/). Without a validator, a crafted field name like
// "../../etc/passwd" would traverse outside the review's upload directory
// when media is stored, and the resulting stored_path would be served back
// via the `/uploads` static handler. Templates are admin-gated so the
// attack requires a compromised admin or a trick during template authoring
// — LOW severity — but defense-in-depth costs one regex.
//
// `^[a-z0-9_]+$` covers every field name currently authored in-repo
// (content, subject, body, recipient, tone, changelog, environment,
// job_title, proposal, confidence, ...) and rejects path separators,
// dot-dot, and whitespace at the schema boundary.
const FieldNameSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9_]+$/,
    "Field name must be lowercase letters, digits, or underscores only",
  );

export const TemplateFieldSchema = z.object({
  name: FieldNameSchema,
  type: FieldTypeSchema,
  label: z.string(),
  readonly: z.boolean().optional(),
  editable: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});

// Configurable-actions primitive (spec §3.2 + §7.1).
// Field-level rules only at this layer: id slug-format, label non-empty,
// kind/decision_value/style closed enums. Cross-field rules
// (decision_value presence/absence by kind, webhook_event-vs-kind) and
// array-level rules (at-least-1-decision, unique ids, no-duplicate-
// decision_values) live on TemplateActionsCanonicalSchema below.
//
// Why both classes of rules at the array layer rather than splitting:
// the middleware (validate.ts) catches refinement issues with
// `code: 'custom'` and message text only — it does NOT surface
// params.code to the response. Routes that want a stable error code
// (e.g. 'template.missing_decision_value') need to run the refinements
// THEMSELVES. Keeping all §7.1 rules on the array schema means there's
// one canonical-validate step at the route handler, surfacing one stable
// code per failure. Per-element-only TemplateActionConfigSchema runs
// inside middleware for the basic shape gate.
//
// requires_role is omitted per spec §12 anti-principle.
const ActionStyleSchema = z.enum(["primary", "destructive", "secondary", "warning"]);

export const TemplateActionConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, "action id must be slug-format"),
  label: z.string().min(1),
  // Agent-facing decision-support text, not decoration: the MCP tool
  // `gatewerk_list_review_actions` returns it to the model as part of each
  // action config, so it is the sanctioned way to tell an LLM what a custom
  // action means. Capped at 500 to match the spirit of the 1000-char chain
  // note cap — it had no bound at all before. Not yet rendered
  // on any human surface.
  description: z.string().max(500).optional(),
  kind: z.enum(ACTION_KINDS),
  decision_value: z.enum(DECISION_VALUES).optional(),
  webhook_event: z.string().optional(),
  requires_feedback: z.boolean().optional(),
  confirmation: z.boolean().optional(),
  style: ActionStyleSchema.optional(),
  icon: z.string().optional(),
  order: z.number().int().optional(),
  enabled_for_status: z.array(ReviewStatusSchema).optional(),
  expose_to_recipient: z.boolean().optional(),
});

export type TemplateActionConfig = z.infer<typeof TemplateActionConfigSchema>;

// Legacy DB shape — pre-configurable-actions structured form. Preserved at
// the boundary for read-time compat per spec §11.2; normalizeTemplateActions()
// upgrades these to canonical shape. Body matches the previous (pre-
// configurable-actions) TemplateActionConfigSchema byte-for-byte so the
// inferred type aligns with the hand-maintained ActionConfig interface in
// packages/shared/src/index.ts — keeps existing TemplateSchema consumers
// (History, Inbox, Templates pages) compiling unchanged.
const LegacyStructuredActionSchema = z.object({
  type: TemplateActionTypeSchema,
  label: z.string().min(1),
  value: z.string().min(1),
});

// API/DB boundary schema — tolerates bare-string arrays, legacy structured,
// AND canonical structured during the Phase 1 → 5 transition. Existing call
// sites continue to compile through the legacy-compatible inferred shape.
// The canonical arm exists because the API serializer normalizes reads to
// canonical — the schema boundary must tolerate canonical responses for
// safeParse on the client side. Storage may be heterogeneous; the wire is
// uniformly canonical.
export const TemplateActionsSchema = z.union([
  z.array(z.string()),
  z.array(LegacyStructuredActionSchema),
  z.array(TemplateActionConfigSchema),
]);

// Canonical-only — for new code paths (action endpoint, editor UI redesign)
// that don't tolerate legacy. Also matches the inferred output type of
// normalizeTemplateActions(). Carries the FULL §7.1 ruleset — both the
// per-element cross-field rules and the array-level rules — so a single
// route-handler validate step surfaces all violations with stable error
// codes via params.code.
export const TemplateActionsCanonicalSchema = z
  .array(TemplateActionConfigSchema)
  .superRefine((actions, ctx) => {
    // §7.1 cross-field per element: decision_value presence/absence and
    // webhook_event-vs-kind. Reported with `path: [i, ...]` so clients
    // can point to the offending row.
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (action.kind === "decision" && !action.decision_value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "decision_value"],
          message: "decision_value is required when kind=decision",
          params: { code: "template.missing_decision_value" },
        });
      }
      if (action.kind !== "decision" && action.decision_value !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "decision_value"],
          message: "decision_value is only valid when kind=decision",
          params: { code: "template.unexpected_decision_value" },
        });
      }
      if (action.kind === "decision" && action.webhook_event !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "webhook_event"],
          message: "webhook_event is not valid for decision-kind actions (events auto-derived)",
          params: { code: "template.unexpected_webhook_event" },
        });
      }
    }

    // §7.1 array-level: at least 1 decision-kind action.
    // Per spec §S19, a template with only ONE decision action (positive-
    // terminal-only Acknowledge-style workflows) is valid — the rule is
    // "at least 1 decision", not "at least 1 approve AND 1 reject". This
    // is a deliberate loosening from the legacy `normalizeActions` rule
    // ("must have approve AND reject") to enable v1.4 vertical-vocabulary
    // use cases.
    const decisionCount = actions.filter((a) => a.kind === "decision").length;
    if (decisionCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "Template must have at least one action with kind='decision'",
        params: { code: "template.no_terminal_action" },
      });
    }

    // §7.1 array-level: action.id unique within template.
    const idIndex = new Map<string, number>();
    for (let i = 0; i < actions.length; i++) {
      const id = actions[i].id;
      const seenAt = idIndex.get(id);
      if (seenAt !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "id"],
          message: `Duplicate action id '${id}' (first occurrence at index ${seenAt})`,
          params: { code: "template.duplicate_action_id" },
        });
      } else {
        idIndex.set(id, i);
      }
    }

    // §7.1 array-level: at most one action per decision_value. Two
    // 'approved'-equivalent or two 'rejected'-equivalent decisions create
    // audit fragmentation — spec §6 closed-binary-decision rationale.
    const decisionValueIndex = new Map<string, number>();
    for (let i = 0; i < actions.length; i++) {
      const dv = actions[i].decision_value;
      if (!dv) continue;
      const seenAt = decisionValueIndex.get(dv);
      if (seenAt !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "decision_value"],
          message: `Duplicate decision_value '${dv}' (first occurrence at index ${seenAt})`,
          params: { code: "template.duplicate_decision_value" },
        });
      } else {
        decisionValueIndex.set(dv, i);
      }
    }
  });
export type TemplateActionsCanonical = z.infer<typeof TemplateActionsCanonicalSchema>;

// Default presets the system ships (spec §3.3). New templates default to
// [approve, reject]; users add request_changes or other custom actions
// explicitly. `satisfies` keeps each preset typechecked against
// TemplateActionConfig without widening the inferred literal types.
export const DEFAULT_ACTION_PRESETS = {
  approve: {
    id: "approve",
    label: "Approve",
    kind: "decision",
    decision_value: "approved",
    style: "primary",
    // Token redesign Phase 1 (spec §4.2): widened from default ['pending']
    // to also accept 'awaiting_external'. POST /reviews/:id/token transitions
    // pending → awaiting_external; the token-decide path then routes through
    // executeReviewAction which now sees 'awaiting_external' as a valid
    // pre-state for decision actions.
    enabled_for_status: ["pending", "awaiting_external"],
  },
  reject: {
    id: "reject",
    label: "Reject",
    kind: "decision",
    decision_value: "rejected",
    style: "destructive",
    requires_feedback: true,
    confirmation: true,
    // Token redesign Phase 1 (spec §4.2): see approve preset comment.
    enabled_for_status: ["pending", "awaiting_external"],
  },
  request_changes: {
    id: "request_changes",
    label: "Request Changes",
    kind: "iteration",
    webhook_event: "review.changes_requested",
    requires_feedback: true,
    style: "secondary",
  },
  // Spec §S14: cancel an in-flight iteration, reverting awaiting_iteration →
  // pending. Modeled as side_effect kind with the cancel_iteration id —
  // dispatcher recognizes the id and applies the revert. Legacy
  // /cancel-request endpoint becomes a thin alias around this preset.
  cancel_iteration: {
    id: "cancel_iteration",
    label: "Cancel Iteration",
    kind: "side_effect",
    enabled_for_status: ["awaiting_iteration"],
    style: "secondary",
  },
  // Spec §S14b: terminal reject directly from awaiting_iteration without a
  // prior cancel-request call. Sidesteps the /action guard that 409s plain
  // 'reject' on awaiting_iteration by using a distinct id with an explicit
  // enabled_for_status. The snapshot loop auto-injects this into every review,
  // but enabled_for_status gates it to awaiting_iteration in both the UI
  // (filterEnabled) and the action engine, so it never surfaces elsewhere.
  reject_from_iteration: {
    id: "reject_from_iteration",
    label: "Reject",
    kind: "decision",
    decision_value: "rejected",
    style: "destructive",
    confirmation: true,
    enabled_for_status: ["awaiting_iteration"],
  },
} as const satisfies Record<string, TemplateActionConfig>;

// Read-time transformer (spec §11.2). Auto-upgrades three legacy DB shapes
// to canonical structured form: bare-string array, {type,label,value}
// objects, already-structured objects (passthrough validate). Lazy
// write-back happens on next template update; storage stays mixed until
// then. Returns [] on unrecognized input rather than throwing — the
// caller (route handler) decides whether absent actions is an error.
export function normalizeTemplateActions(raw: unknown): TemplateActionConfig[] {
  if (!Array.isArray(raw)) return [];

  const result: TemplateActionConfig[] = [];
  for (const item of raw) {
    if (item && typeof item === "object" && "kind" in item && "id" in item) {
      const parsed = TemplateActionConfigSchema.safeParse(item);
      if (parsed.success) result.push(parsed.data);
      continue;
    }
    if (item && typeof item === "object" && "type" in item) {
      const type = (item as { type: string }).type;
      const preset = DEFAULT_ACTION_PRESETS[type as keyof typeof DEFAULT_ACTION_PRESETS];
      if (preset) {
        const label = (item as { label?: string }).label;
        result.push(label ? { ...preset, label } : { ...preset });
      }
      continue;
    }
    if (typeof item === "string") {
      const preset = DEFAULT_ACTION_PRESETS[item as keyof typeof DEFAULT_ACTION_PRESETS];
      if (preset) result.push({ ...preset });
    }
  }
  return result;
}

const DraftConfigSchema = z
  .record(z.string().max(100), z.unknown())
  .refine(
    (obj) => Object.keys(obj).length <= 50,
    "Draft config must not exceed 50 keys",
  );

export const TemplateObjectSchema = z.object({
  object: z.literal("template").optional(),
  id: z.string(),
  slug: z.string(),
  project_id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  fields: z.array(TemplateFieldSchema),
  actions: TemplateActionsSchema,
  default_priority: z.enum(PRIORITIES),
  enable_review_links: z.boolean().optional(),
  auto_approve: z.boolean().optional(),
  timeout_seconds: z.number().int().nullable().optional(),
  timeout_action: z.enum(TIMEOUT_ACTIONS).nullable().optional(),
  changes_timeout_hours: z.number().int().nullable().optional(),
  instructions: z.string().nullable().optional(),
  // Per-template UX gates — frontend reads these to hide Request Changes /
  // Notes when disabled. Default true preserves legacy "all features on".
  allow_request_changes: z.boolean().optional(),
  allow_notes: z.boolean().optional(),
  allow_monitoring: z.boolean().optional(),
  // Spec section 8.5. Pre-fill defaults consumed by ShareViaLinkDialog on open
  // so the reviewer's selection from the template editor flows through to
  // every generated link without a network round-trip.
  default_auth_level: z.enum(["public", "email_otp", "account"]).optional(),
  default_expiry_seconds: z.number().int().min(TOKEN_EXPIRY_SECONDS.MIN).max(TOKEN_EXPIRY_SECONDS.MAX).optional(),
  status: TemplateStatusSchema.optional(),
  draft_config: DraftConfigSchema.nullable().optional(),
  draft_updated_at: IsoDateString.nullable().optional(),
  // v1 agent primitives (migration 070). Template-level default for the
  // max_iterations guardrail — inherited by reviews when the per-review field
  // is absent. TimeoutWorker closes awaiting_iteration reviews that hit this cap.
  max_iterations: z.number().int().positive().nullable().optional(),
  // M12: chain definition lives on the template (spec §13 Q1 option a). When
  // non-null, POST /reviews against this template auto-spawns a chain_run via
  // ChainEngine.createRun and the new review becomes step 1.
  //
  // Response uses the loose passthrough shape because ChainDefinitionSchema
  // carries a .default("terminate") on rejection_policy that cascades into
  // every consumer of the inferred output type, breaking generic mutation
  // wrappers in the web client. Strict shape validation runs on write via
  // TemplateCreateBodySchema / TemplateUpdateBodySchema below.
  chain_config: DraftConfigSchema.nullable().optional(),
  created_at: IsoDateString.optional(),
  updated_at: IsoDateString.optional(),
});

export const TemplateListResponseSchema = z.object({
  object: z.literal("list"),
  items: z.array(TemplateObjectSchema),
  has_more: z.boolean(),
  total: z.number().int().nonnegative(),
});

export const TemplateCreateBodySchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  fields: z.array(TemplateFieldSchema).min(1, "A template must have at least one field."),
  actions: TemplateActionsSchema.optional(),
  default_priority: z.enum(PRIORITIES).optional(),
  enable_review_links: z.boolean().optional(),
  auto_approve: z.boolean().optional(),
  timeout_seconds: z.number().int().min(60).nullable().optional(),
  timeout_action: z.enum(TIMEOUT_ACTIONS).nullable().optional(),
  instructions: z.string().nullable().optional(),
  allow_request_changes: z.boolean().optional(),
  allow_notes: z.boolean().optional(),
  allow_monitoring: z.boolean().optional(),
  default_auth_level: z.enum(["public", "email_otp", "account"]).optional(),
  default_expiry_seconds: z.number().int().min(TOKEN_EXPIRY_SECONDS.MIN).max(TOKEN_EXPIRY_SECONDS.MAX).optional(),
  max_iterations: z.number().int().positive().nullable().optional(),
  // Was absent here while present on the update schema, so a create that sent
  // it got a 201 with the value silently stripped by z.object(). Range
  // mirrors the update schema.
  changes_timeout_hours: z.number().int().min(1).nullable().optional(),
  chain_config: ChainDefinitionSchema.nullable().optional(),
});

// PATCH semantics for chain_config: undefined leaves untouched, null clears,
// an object replaces. The route layer converts through to the service which
// only writes the field when the key is explicitly present.
export const TemplateUpdateBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  fields: z.array(TemplateFieldSchema).min(1).optional(),
  actions: TemplateActionsSchema.optional(),
  default_priority: z.enum(PRIORITIES).optional(),
  enable_review_links: z.boolean().optional(),
  auto_approve: z.boolean().optional(),
  timeout_seconds: z.number().int().min(60).nullable().optional(),
  timeout_action: z.enum(TIMEOUT_ACTIONS).nullable().optional(),
  changes_timeout_hours: z.number().int().min(1).nullable().optional(),
  instructions: z.string().nullable().optional(),
  allow_request_changes: z.boolean().optional(),
  allow_notes: z.boolean().optional(),
  allow_monitoring: z.boolean().optional(),
  default_auth_level: z.enum(["public", "email_otp", "account"]).optional(),
  default_expiry_seconds: z.number().int().min(TOKEN_EXPIRY_SECONDS.MIN).max(TOKEN_EXPIRY_SECONDS.MAX).optional(),
  max_iterations: z.number().int().positive().nullable().optional(),
  chain_config: ChainDefinitionSchema.nullable().optional(),
});

// Draft create/update: anything goes (drafts may be partial and invalid).
// Published columns are minimal-defaulted server-side on create; publish()
// is where the strict validation lives.
export const TemplateDraftCreateBodySchema = DraftConfigSchema;
export const TemplateDraftUpdateBodySchema = DraftConfigSchema;

export type TemplateObject = z.infer<typeof TemplateObjectSchema>;
export type TemplateListResponse = z.infer<typeof TemplateListResponseSchema>;
// Use z.input on body types: chain_config's nested ChainDefinitionSchema has
// `.default("terminate")` on rejection_policy, so the parsed (output) shape
// differs from what callers actually provide. defineMutation in the web client
// expects the body type to match the schema's input — using z.infer (output)
// produces a contravariance error. z.input matches what the route handler and
// API client both receive on the wire.
export type TemplateCreateBody = z.input<typeof TemplateCreateBodySchema>;
export type TemplateUpdateBody = z.input<typeof TemplateUpdateBodySchema>;
export type TemplateDraftCreateBody = z.infer<typeof TemplateDraftCreateBodySchema>;
export type TemplateDraftUpdateBody = z.infer<typeof TemplateDraftUpdateBodySchema>;
// Note: `TemplateField` and `ActionConfig` are already exported from the
// top-level shared index as hand-maintained interfaces. Don't re-export the
// Zod-inferred shapes under the same names — keeps a single public type name
// per concept while we migrate callers.

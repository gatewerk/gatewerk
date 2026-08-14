/** surface-tiers/templates — the template editor, its action vocabulary, and field definitions. */
import type { AxisDeclaration } from "./types";
import type { TemplateAxis, ActionAxis, FieldAxis } from "./axes";

// ---------------------------------------------------------------------------
// Templates — six control groups, and that is the whole editor
// ---------------------------------------------------------------------------

/**
 * The template editor exposes six things — name+slug · fields ·
 * action vocabulary · timeout + timeout action · external links on/off ·
 * instructions. `TEMPLATE_EDITOR_GROUP_BUDGET` is the number that makes that
 * arguable rather than atmospheric.
 */
export const TEMPLATE_AXES: Record<TemplateAxis, AxisDeclaration> = {
  // ── group: identity ──
  slug: {
    tier: "core",
    surface: "template-editor",
    group: "identity",
    note: "Immutable after first publish: execute-action resolves a review's action vocabulary from the live template BY SLUG, so a rename would strip custom actions from in-flight reviews.",
  },
  name: { tier: "core", surface: "template-editor", group: "identity" },
  description: {
    tier: "advanced",
    surface: "template-editor",
    group: "identity",
    note: "Not named in spec §1b's split. Kept in the UI rather than put on the roadmap because 'template descriptions' is not a credible public roadmap line. Overlaps confusingly with `instructions` — two free-text fields with no stated difference. Worth collapsing to one.",
  },

  status: {
    tier: "core",
    surface: "template-editor",
    group: "identity",
    note: "Draft | active | inactive, moved by POST /:id/pause and /:id/resume rather than by any body key. Counted under identity rather than as a seventh control group because pause/resume/publish are lifecycle ACTIONS available on every template, not configuration fields — the six describe what the editor lets you configure. Move it to its own group if you disagree; that changes the budget to seven.",
  },
  draft_config: {
    tier: "request",
    note: "The whole body of PATCH /:id/draft — z.record with values entirely unvalidated, deliberately, because a draft may be partial and invalid. A save buffer rather than a control. Note the consequence: publish() then promotes 16 keys out of it with none of the refinements PUT enforces on the identical columns (spec §5.4).",
  },

  // ── group: fields ──
  fields: { tier: "core", surface: "template-editor", group: "fields" },

  // ── group: actions ──
  actions: { tier: "core", surface: "template-editor", group: "actions" },

  // ── group: timeout ──
  timeout_seconds: { tier: "core", surface: "template-editor", group: "timeout" },
  timeout_action: {
    tier: "core",
    surface: "template-editor",
    group: "timeout",
    note: "Inheritance onto directly-created reviews was fixed in S1. Still INERT on the chain path — see spec §5.1 before touching it.",
  },

  // ── group: external-links ──
  enable_review_links: {
    tier: "core",
    surface: "template-editor",
    group: "external-links",
    note: "Hard gate on minting any external link. Unreachable from the TS SDK, MCP and n8n — spec §7.",
  },

  // ── group: instructions ──
  instructions: { tier: "core", surface: "template-editor", group: "instructions" },

  // ── chains live on their own screen, not in the six ──
  chain_config: {
    tier: "core",
    surface: "chain-builder",
    group: "chain-definition",
    note: "Core because routing stays in the engine, but it is not one of the editor's six groups — it is a separate screen. Reached through publish() with none of PUT's validation: spec §5.4.",
  },

  // ── held ──
  auto_approve: {
    tier: "roadmap",
    roadmap: { feature: "Auto-approving templates", built: true },
    note: "Decides at create with decided_by='system/auto-approve'. A template that needs no human is a legitimate capability and a strange thing to lead a human-oversight product with.",
  },
  allow_notes: {
    tier: "roadmap",
    roadmap: { feature: "Per-template feature switches", built: true },
    note: "Honoured in apps/web only; no server gate and zero readers in web-next.",
  },
  allow_request_changes: {
    tier: "roadmap",
    roadmap: { feature: "Per-template feature switches", built: true },
    note: "Became a real gate in S1; had zero readers before that.",
  },
  allow_monitoring: {
    tier: "roadmap",
    roadmap: { feature: "Monitoring gates: act first, human vetoes inside a window", built: true },
    note: "Monitoring gates ship after launch and are named in the roadmap.",
  },
  default_priority: {
    tier: "core",
    surface: "template-editor",
    group: "identity",
    note: "RETIERED roadmap → core. All four design prototypes surface it, both as an editor control and as the templates list-row readout ('Draft / Normal / 2 fields'). It is one dropdown with four values and it lands in the existing `identity` group, so it costs no control group and the budget stays 6. Priority is how the inbox sorts, which made 'Template-level defaults for new reviews' a weak public roadmap line; that line is now gone. ⚠️ Still true and now surfaced: there is no DB CHECK on this column and publish() does not re-validate it, so a poisoned value propagates onto every review and fails as a 500 far from its cause — spec §5.4 asks for that CHECK.",
  },
  default_auth_level: {
    tier: "roadmap",
    roadmap: { feature: "Template-level defaults for external links", built: true },
    note: "Resolved on the chain path. On the manual path it is read in ONE DIRECTION: it may raise the share modal's tier to email_otp or account, never lower it to public — `public` is this column's DB default (migration 039), so honouring it verbatim would hand public links back on every template nobody has configured. Still roadmap tier because the editor draws no control for it; web-core/state/inbox/share-auth-default.ts.",
  },
  default_expiry_seconds: {
    tier: "roadmap",
    roadmap: { feature: "Template-level defaults for external links", built: true },
    note: "Three live defaults for one concept: 24h template, 48h manual, 7d chain fallback.",
  },
  max_iterations: {
    tier: "roadmap",
    roadmap: { feature: "Iteration limits and send-back SLAs", built: true },
    note: "Had a column, a CHECK, Zod and worker enforcement but zero write path until S1.",
  },
  changes_timeout_hours: {
    tier: "roadmap",
    roadmap: { feature: "Iteration limits and send-back SLAs", built: true },
    note: "Read live by slug, so editing a template retimes every in-flight iteration review — spec §2.2.",
  },
};

/** The six. Raising this needs a case, in a PR. */
export const TEMPLATE_EDITOR_GROUP_BUDGET = 6;

// ---------------------------------------------------------------------------
// Actions — four fields
// ---------------------------------------------------------------------------

/**
 * An action is `id` · `label` · `kind` · `decision_value`.
 * Those four are core and the budget below counts them.
 *
 * `style` sits beside them as one advanced bit, not a fifth core field.
 * Approve and reject still derive it — approved renders primary, rejected
 * renders destructive — but send_back and notify imply no colour at all, and
 * every reader has honoured `style: "destructive"` since long before the
 * editor could set it, so a destructive custom action was reachable over the
 * API and unreachable on screen. See the axis note.
 */
export const ACTION_AXES: Record<ActionAxis, AxisDeclaration> = {
  id: { tier: "core", surface: "template-editor", group: "actions" },
  label: { tier: "core", surface: "template-editor", group: "actions" },
  kind: { tier: "core", surface: "template-editor", group: "actions" },
  decision_value: { tier: "core", surface: "template-editor", group: "actions" },

  style: {
    tier: "advanced",
    surface: "template-editor",
    group: "actions",
    note: "ONE BIT of it, not the enum. Approve and reject keep deriving it — an approve that renders red is a contradiction, not a setting — so the switch is drawn only on send_back and notify, which have no implied colour and are where a genuinely destructive custom action lands. The earlier framing of this as a knob that disappears with nothing lost understated the loss. Every reader has honoured `style: \"destructive\"` all along (web-core actionTone, apps/web resolveActionStyle), so a destructive send-back was reachable over the API and unreachable in the editor, and the editor's own action chip painted a colour the reviewer would not see. `secondary` and `warning` remain API-only and survive a save untouched.",
  },
  icon: {
    tier: "roadmap",
    roadmap: { feature: "Action presentation: icon and ordering", built: true },
    note: "Free string; only 13 names resolve to a glyph. The icon-drawing renderer mounts on the main pending decision path as well as awaiting_iteration, so icons do render in the launch inbox today. Held anyway: an unvalidated free-text field where 13 magic values work and everything else silently renders nothing is a bad control to ship. Tightening it to an enum is a landmine — spec §5.2.",
  },
  order: {
    tier: "roadmap",
    roadmap: { feature: "Action presentation: icon and ordering", built: true },
    note: "The sort reads it; nothing writes it. The editor's drag-reorder calls arrayMove without ever setting `order`, so every editor-authored action sorts alphabetically.",
  },
  requires_feedback: {
    tier: "roadmap",
    roadmap: { feature: "Mandatory feedback and confirmation prompts per action", built: true },
    note: "Server-enforced, rejects whitespace-only.",
  },
  confirmation: {
    tier: "roadmap",
    roadmap: { feature: "Mandatory feedback and confirmation prompts per action", built: true },
    note: "The claim that an API caller never sees it would be wrong — confirmation IS returned on the REST review read path and named explicitly by the MCP tool contract. What is true is narrower and still the reason to hold it: there is no SERVER-SIDE enforcement, so it is advisory to whatever renders the button and a direct API caller can simply ignore it.",
  },
  enabled_for_status: {
    tier: "roadmap",
    roadmap: { feature: "Lifecycle-scoped actions", built: true },
    note: "The highest-leverage knob in the product — it decides which lifecycle states an action can fire in. Defaults to ['pending'].",
  },
  expose_to_recipient: {
    tier: "roadmap",
    roadmap: { feature: "Per-action visibility on external review links", built: true },
  },
  webhook_event: {
    tier: "roadmap",
    roadmap: { feature: "Custom webhook event names per action", built: true },
    note: "Iteration and side-effect actions only; forbidden on kind=decision.",
  },
  description: {
    tier: "roadmap",
    roadmap: { feature: "Agent-facing action descriptions", built: true },
    note: "Live MCP contract — gatewerk_list_review_actions returns it to the model. Agent-facing decision support, not decoration. Do not delete: spec §5.6.",
  },
};

/** Four. `id` · `label` · `kind` · `decision_value`. */
export const ACTION_FIELD_BUDGET = 4;

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

export const FIELD_AXES: Record<FieldAxis, AxisDeclaration> = {
  name: {
    tier: "core",
    surface: "template-editor",
    group: "fields",
    note: "The /^[a-z0-9_]+$/ regex is a path-traversal defense — field names flow into media filenames.",
  },
  type: {
    tier: "core",
    surface: "template-editor",
    group: "fields",
    note: "11 canonical types; the editor exposes 10 (no video) and MCP exposes 8. Surfaces disagree — spec §2.4.",
  },
  label: { tier: "core", surface: "template-editor", group: "fields" },
  options: {
    tier: "core",
    surface: "template-editor",
    group: "fields",
    note: "Required for type=select. The field row has a Configure gear opening an inline panel that holds the field's label and, for select, an ordered options list with add, rename and remove. Selecting `select` seeds an empty array, and a `Needs options` chip marks the row until one is usable. Before the control existed this axis was declared core, so picking `select` produced a template that could not publish, with an error naming a concept absent from the screen. The two adjacent defects went with it: canPublish now runs the shared field rule rather than gating on actions alone, and the JSON tab is a complete read-only Export that no longer strips options.",
  },
  editable: {
    tier: "advanced",
    surface: "template-editor",
    group: "fields",
    note: "Per-field, inside the fields group, so it costs no control group. Server-side enforcement landed in S1 and stays on regardless of whether the toggle is surfaced — before it, an unauthenticated public-link holder could rewrite the payload the agent executes.",
  },
  readonly: {
    tier: "inert",
    note: "The claim 'read by nothing' would be overstated — web-next computes editable as (f.editable === true && f.readonly !== true), so there IS a live reader. The accurate claim is the weaker one: the value never ARRIVES at that reader, because both feeds are normalized first, so the branch can never fire. Harmless in outcome — absent `editable` already means non-editable — but seed.ts authors it on 18 fields and hrp-v1.md teaches it as canonical. Duplicates `editable`; the collapse is spec §4.5.",
  },
};

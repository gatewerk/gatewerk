/** surface-tiers/chains — chain definitions, steps, assignees, and runs. */
import type { AxisDeclaration } from "./types";
import type { ChainAxis, ChainRunAxis } from "./axes";

// ---------------------------------------------------------------------------
// Chains — sequential steps, internal assignees, reject aborts
// ---------------------------------------------------------------------------

/**
 * ⚠️ `surface: "chain-builder"` names a REGION, not a route.
 *
 * An apparent conflict is settled between the locked UI doctrine ("no feature
 * gets its own front door") and this surface value. There is no conflict:
 *
 * - `LaunchSurface` is a screen-region enum, and `controlGroupsOn()` counts
 *   groups PER SURFACE — so chain axes have never counted against the template
 *   editor's six-group budget, and naming them here changes no budget.
 * - "Front door" in the doctrine means a route, a nav item, or a named
 *   destination a user must learn. Chains have none and gain none: there is no
 *   /chains route (apps/web/src/catchall.tsx), no nav entry (NavDrawer.tsx,
 *   IconRail.tsx), and the editor is a section at the bottom of the template
 *   detail pane (TemplateDetail.tsx, the ChainEditor mount). The design language agrees — the
 *   full-app prototype renders CHAIN as a section inside the template detail.
 *
 * So: chains are configured inside the template editor, and a running chain is
 * observed and aborted from inside the review that IS its current step — not
 * from a runs page. Building one would be a new front door AND a new API:
 * GET /chain-runs does not exist (routes/chains.ts:386-388 voids the envelope).
 *
 * Ships as a section. If chain is ever to be
 * counted as a seventh template-editor control group, that is a deliberate
 * budget change in packages/shared/src/__tests__/surface-tiers.test.ts.
 */

const LADDER_ROADMAP = {
  feature: "Assignment ladders: hand a decision onward when nobody answers",
  built: true,
} as const;

const PARALLEL_ROADMAP = {
  feature: "Parallel and conditional chains",
  built: false,
} as const;

const EXTERNAL_STEP_ROADMAP = {
  feature: "External-recipient chain steps",
  built: true,
} as const;

const REJECTION_ROADMAP = {
  feature: "Chain rejection policies: continue past a rejection, or branch back",
  built: true,
} as const;

export const CHAIN_AXES: Record<ChainAxis, AxisDeclaration> = {
  version: {
    tier: "request",
    note: "Literal '1.0'. Retiered from core for consistency with the ruling that action.style is DERIVED rather than configured: a value the builder writes as a constant is not a control, and calling it one inflates the launch surface with a dropdown that has one option.",
  },
  name: { tier: "core", surface: "chain-builder", group: "chain-definition" },
  description: { tier: "advanced", surface: "chain-builder", group: "chain-definition" },
  template: {
    tier: "core",
    surface: "chain-builder",
    group: "chain-definition",
    note: "C1: the entry template every step of the route reviews against. Not a control on the template page — the route IS that template's property, so the value is implied by the page you are on. POST /chain-runs, which has no owning template, requires it explicitly.",
  },
  mode: {
    tier: "request",
    note: "Only 'sequential' validates — parallel and mixed are refused in every edition, so there is exactly one legal value and nothing for a human to choose. Retiered from core, same reasoning as version. The held VALUES appear on the roadmap as parallel chains.",
  },
  steps: { tier: "core", surface: "chain-builder", group: "steps" },
  metadata: { tier: "request" },

  rejection_policy: {
    tier: "inert",
    note: "Run-level policy. resolvePolicy reads ONLY the step policy and defaults to abort; the run-level value is echoed into the audit row and the webhook and controls nothing. Choosing 'restart on rejection' at the chain level aborts the chain instead. Do not surface it until it is wired.",
  },
  parallel_groups: { tier: "roadmap", roadmap: PARALLEL_ROADMAP, note: "Schema surface for a feature that was never built; presence is refused at validation." },
  extensions: {
    tier: "inert",
    note: "Forward-compatibility escape hatch on the definition. No reader in the engine.",
  },

  "step.id": { tier: "core", surface: "chain-builder", group: "steps" },
  "step.name": { tier: "core", surface: "chain-builder", group: "steps", note: "Also the default recipient_label for external-token steps." },
  "step.description": {
    tier: "core",
    surface: "chain-builder",
    group: "steps",
    note: "C1: the step's guidance, one free-text line shown to that step's reviewer. Promoted from advanced because it is now one of exactly two controls per step (who, and what they should weigh). It inherits the one legitimate job per-step templates were doing.",
  },
  "step.template": {
    tier: "inert",
    note: "RETIRED. A chain is a route of approvers over one request, so every step resolves the chain's entry template and a step naming its own is meaningless. The key stays in the schema because ChainAxis is type-derived from it, and because a non-strict zod object would strip the field from a legacy chain_config on its first save anyway. Read in exactly one place: as the entry-template fallback for a definition written before the envelope `template` existed.",
  },
  "step.assignee": { tier: "core", surface: "chain-builder", group: "steps" },
  "step.priority": { tier: "advanced", surface: "chain-builder", group: "steps" },
  "step.metadata": { tier: "request" },
  "step.timeout_seconds": {
    tier: "roadmap",
    roadmap: { feature: "Chain step timeouts", built: false },
    note: "The defect that makes this roadmap rather than core: materializeStep writes timeout_seconds but never expires_at, and processExpired filters on expires_at IS NOT NULL, so no chain step can ever time out. The knob persisted, rehydrated in the editor, and a stalled step waited forever. The one-line fix is a landmine — spec §5.1 — because populating expires_at alone lets the worker auto-approve and ADVANCE a chain, breaking 'chain advancement is human-only by construction'. REMOVED FROM THE EDITOR. ⚠️ Removing the control exposed a second, worse defect: the editor's minutes field divided by 60 on load and multiplied back on save, so an API-set value that was not a multiple of 60 was SILENTLY REWRITTEN by an unrelated edit — 90 seconds came back as 120. The value now rides through the step's raw stash untouched, covered by draft-config-preservation.test.ts.",
  },
  "step.depends_on": {
    tier: "inert",
    note: "Reference-validated and never read: the engine advances by step_number + 1. It reaches callers twice (its own column and assignee_spec). The MCP tool description that told models it creates a dependency was corrected in 640bc92. Do not delete — spec §5.8.",
  },
  "step.rejection_policy": {
    tier: "roadmap",
    roadmap: REJECTION_ROADMAP,
    note: "All three policies work and are tested. Launch ships the default only: NULL means abort, and reject aborts the run. `continue` is held because it reports a chain as `completed` when its final step was REJECTED.",
  },
  "step.rejection_branch_to": { tier: "roadmap", roadmap: REJECTION_ROADMAP },
  "step.parallel_group": { tier: "roadmap", roadmap: PARALLEL_ROADMAP },
  "step.condition": { tier: "roadmap", roadmap: PARALLEL_ROADMAP },

  "step.assignee.kind": {
    tier: "core",
    surface: "chain-builder",
    group: "steps",
    note: "Launch surfaces the internal values (user, role). external_token is held — see External-recipient chain steps.",
  },
  "step.assignee.email": { tier: "core", surface: "chain-builder", group: "steps" },
  "step.assignee.user_id": { tier: "core", surface: "chain-builder", group: "steps" },
  "step.assignee.role": { tier: "core", surface: "chain-builder", group: "steps", note: "admin | reviewer." },

  "step.assignee.recipient_label": { tier: "roadmap", roadmap: EXTERNAL_STEP_ROADMAP },
  "step.assignee.purpose": { tier: "roadmap", roadmap: EXTERNAL_STEP_ROADMAP },
  "step.assignee.expires_in_seconds": { tier: "roadmap", roadmap: EXTERNAL_STEP_ROADMAP },
  "step.assignee.auth_level": {
    tier: "roadmap",
    roadmap: EXTERNAL_STEP_ROADMAP,
    note: "public | email_otp; 'account' is hard-blocked in every edition. email_otp steps hard-fail without SMTP, which is part of why external steps are held.",
  },
  "step.assignee.auth_email": { tier: "roadmap", roadmap: EXTERNAL_STEP_ROADMAP },
  "step.assignee.auth_user_id": { tier: "roadmap", roadmap: EXTERNAL_STEP_ROADMAP },
  "step.assignee.grace_period_seconds": {
    tier: "inert",
    note: "Validated, persisted in the definition, and preserved on round-trip by the dashboard chain editor's raw-step stash — but it has no BEHAVIOURAL reader anywhere: no expiry check consults it, because there is no expiry-tolerance semantic to hook it into. Do not wire it — spec §5.7. It no longer has a FORM CONTROL. External-recipient chain steps are held, so the whole token sub-panel left the editor; the value survives an edit rather than being re-entered by a human.",
  },
  "step.assignee.note": {
    tier: "inert",
    note: "ResolvedTokenInputs has no note field and the engine never passes one, so an operator's chain-step note persists in the definition and the token's note column stays NULL. Ranked low: no frontend renders a token note at all.",
  },
};

// ---------------------------------------------------------------------------
// Chain runs — the entry point to a chain
// ---------------------------------------------------------------------------

export const CHAIN_RUN_AXES: Record<ChainRunAxis, AxisDeclaration> = {
  definition: {
    tier: "core",
    surface: "chain-builder",
    group: "chain-definition",
    note: "A run may carry its own definition inline rather than referencing a template's chain_config.",
  },
  initial_payload: { tier: "request", note: "The chain analogue of review.payload; seeds step 1." },
  callback_url: { tier: "request", note: "Run-level, distinct from review.callback_url. SSRF-guarded at the route." },
  metadata: { tier: "request", note: "Run-level, distinct from the definition's metadata. Definition wins on merge." },
};

// Pure helpers for the ActionRow inbox-pane visible-action computation.
// Extracted from ActionRow.tsx so the filter / sort / overflow split and the
// optimistic-patch derivation are testable without React (apps/web has no
// jsdom — matches the action-editor-modal-state and chain-step-indicator-
// helpers precedents).
//
// Inputs are the canonical-normalized template.actions array + the current
// review status; outputs are display-ready slices the component renders
// without further branching.

import {
  DEFAULT_ACTION_PRESETS,
  normalizeTemplateActions,
  type TemplateActionConfigCanonical,
  type ReviewStatus,
} from "@gatewerk/shared";
import type { ActionButtonStyle } from "./action-button-state";

/**
 * Filter to actions enabled for the current review status. Default
 * `enabled_for_status` (when omitted on the action config) is `["pending"]` —
 * matches DEFAULT_ACTION_PRESETS.approve / reject defaults so user-authored
 * actions without an explicit list don't leak to non-pending statuses.
 */
export function filterEnabled(
  actions: readonly TemplateActionConfigCanonical[],
  status: ReviewStatus,
): TemplateActionConfigCanonical[] {
  return actions.filter((a) => {
    const enabled = a.enabled_for_status ?? ["pending"];
    return enabled.includes(status);
  });
}

/**
 * Stable order: numeric `order` ascending (default 0 for omitted), then
 * alphabetical id as the tie-breaker. Matches Phase 4 editor's "Save
 * preserves the user's drag order" semantic so render-side sort never
 * disagrees with the editor's visible order.
 */
export function sortStable(
  actions: readonly TemplateActionConfigCanonical[],
): TemplateActionConfigCanonical[] {
  return [...actions].sort((a, b) => {
    const orderDiff = (a.order ?? 0) - (b.order ?? 0);
    if (orderDiff !== 0) return orderDiff;
    return a.id.localeCompare(b.id);
  });
}

export interface InlineOverflowSlice {
  inline: TemplateActionConfigCanonical[];
  overflow: TemplateActionConfigCanonical[];
}

/**
 * Linear / Slack / Stripe convention: 2 inline buttons + a [More ▾]
 * dropdown for the rest. Threshold lives here so a future density
 * tweak is a single change.
 */
export const INLINE_LIMIT = 2;

export function sliceInlineOverflow(
  actions: readonly TemplateActionConfigCanonical[],
): InlineOverflowSlice {
  return {
    inline: actions.slice(0, INLINE_LIMIT),
    overflow: actions.slice(INLINE_LIMIT),
  };
}

/**
 * Resolve visible+sliced actions for a given status. Convenience composition
 * so the component renders one call instead of nested filter/sort/slice.
 */
export function resolveVisibleActions(
  actions: readonly TemplateActionConfigCanonical[],
  status: ReviewStatus,
): InlineOverflowSlice {
  return sliceInlineOverflow(sortStable(filterEnabled(actions, status)));
}

export interface OptimisticPatchInput {
  /** Previously cached review row, or undefined if the cache was empty. */
  prev: { status: ReviewStatus; decided_at: string | null } | undefined;
  /** The action config the user just clicked. */
  action: TemplateActionConfigCanonical;
  /** Wall-clock ISO timestamp at click time (caller passes new Date().toISOString()). */
  nowIso: string;
}

/**
 * Decide what optimistic patch to apply for the action's `kind`. Decision
 * actions get an immediate status="decided" + decided_at flip so the row
 * exits the inbox without waiting on the server response. Iteration and
 * side_effect kinds let the server response reconcile via
 * invalidateOnSuccess — fabricating an awaiting_iteration transition
 * client-side risks divergence (the cancel preset moves status BACK to
 * pending, for instance, and we'd need full state-machine knowledge to
 * mirror that locally).
 *
 * Returns `undefined` to leave the cache untouched (callers must check).
 */
export function kindToOptimisticPatch(
  input: OptimisticPatchInput,
): Record<string, unknown> | undefined {
  const { prev, action, nowIso } = input;
  if (!prev) return undefined;
  if (action.kind === "decision") {
    return {
      ...prev,
      status: "decided" as ReviewStatus,
      decision: action.decision_value ?? null,
      decided_at: nowIso,
    };
  }
  // Iteration / side_effect: server response is the source of truth.
  return undefined;
}

/**
 * Derive the ActionButton style for an action config. Exported so the
 * decision rail can use the same mapping without duplicating the logic.
 *   1. Explicit action.style always wins.
 *   2. decision + approved → primary.
 *   3. decision + rejected → destructive.
 *   4. iteration kind → warning.
 *   5. Anything else → secondary.
 */
export function resolveActionStyle(action: TemplateActionConfigCanonical): ActionButtonStyle {
  if (action.style) return action.style as ActionButtonStyle;
  if (action.kind === "decision" && action.decision_value === "approved") return "primary";
  if (action.kind === "decision" && action.decision_value === "rejected") return "destructive";
  if (action.kind === "iteration") return "warning";
  return "secondary";
}

// Whitelist of icon names that ActionRow knows how to render. Lucide
// imports cost ~2KB per icon in the bundle, so the surface is constrained
// to the set we ship presets for + a small extension for common
// vertical-vocabulary actions (escalate, flag, archive). Unknown icon
// names fall back to no icon — the label still renders.
export const ICON_WHITELIST = [
  "approve",
  "reject",
  "request_changes",
  "cancel_iteration",
  "escalate",
  "flag",
  "archive",
  "send",
  "skip",
  "block",
  "alert",
  "check",
  "x",
] as const;

export type IconName = (typeof ICON_WHITELIST)[number];

export function isKnownIcon(name: string | undefined): name is IconName {
  if (!name) return false;
  return (ICON_WHITELIST as readonly string[]).includes(name);
}

/**
 * Pick the success-flash label for a decision-kind action. Uses the
 * action's decision_value as the past-tense source ("approved" → "Approved",
 * "rejected" → "Rejected"). Non-decision actions fall back to the canonical
 * label since they don't have a one-word past-tense form (cancel_iteration
 * → "Cancelled" would need an extra mapping that's not worth maintaining
 * for the brief flash window).
 */
export function successLabelFor(action: TemplateActionConfigCanonical): string {
  if (action.kind === "decision" && action.decision_value === "approved") return "Approved";
  if (action.kind === "decision" && action.decision_value === "rejected") return "Rejected";
  return action.label;
}

/**
 * Symmetrizes the client render path with the server-side action service:
 * `apps/api/src/services/reviews/execute-action.ts` blanket-injects all
 * DEFAULT_ACTION_PRESETS into the action snapshot before dispatch. The client
 * inbox renderer historically relied on the now-deleted hardcoded
 * CancelRequestButton for the awaiting_iteration cancel affordance — every
 * template (regardless of authored actions) had a cancel button. After the
 * Phase 5 Iter 2 migration to config-driven ActionRow, the cancel button
 * disappears for any template not explicitly authoring `cancel_iteration`
 * in its actions array. This helper restores the hardcoded-button parity by
 * appending the preset when missing on awaiting_iteration.
 *
 * Scope: only `cancel_iteration` is auto-injected (the preset whose absence
 * causes the stuck-state outage). Other DEFAULT_ACTION_PRESETS stay user-
 * controlled via the template editor — re-injecting `request_changes` (for
 * example) would surprise authors who deliberately removed it.
 *
 * Always returns a fresh array (not the input reference) so callers can't
 * accidentally mutate the upstream cache.
 */
export function withSystemDefaults(
  actions: readonly TemplateActionConfigCanonical[],
  status: ReviewStatus,
): TemplateActionConfigCanonical[] {
  if (status !== "awaiting_iteration") return [...actions];
  if (actions.some((a) => a.id === "cancel_iteration")) return [...actions];
  // Route through normalizeTemplateActions so the literal-narrowed const
  // shape from DEFAULT_ACTION_PRESETS widens cleanly into
  // TemplateActionConfigCanonical (the hand-maintained mirror), avoiding a
  // brittle cast against the `as const satisfies Record<...>` declaration.
  const [canonical] = normalizeTemplateActions([
    DEFAULT_ACTION_PRESETS.cancel_iteration,
  ]) as TemplateActionConfigCanonical[];
  return canonical ? [...actions, canonical] : [...actions];
}

// Pure helpers for the token recipient page's visible-action computation.
// Spec §8.4: token recipient sees decision-kind actions filtered by
// `expose_to_recipient`. Side_effect / iteration kinds are not surfaced
// because the /r/:token/action wire only dispatches decision-kind actions.
//
// Extracted as pure functions so the filter chain + recipient-surface safety
// override are testable without React (apps/web has no jsdom).

import {
  DEFAULT_ACTION_PRESETS,
  normalizeTemplateActions,
  type TemplateActionConfigCanonical,
} from "@gatewerk/shared";

/**
 * Filters the canonical action list down to what a token recipient should see
 * (spec §8.4): decision-kind actions with `expose_to_recipient !== false` (the
 * undefined default is "visible") AND `decision_value` present (the legacy
 * /r/:token/action wire only dispatches decision-kind actions, so non-
 * dispatchable actions would render as guaranteed-failing buttons on the
 * /r/:token/action wire).
 *
 * Bare-template fallback: when the input is empty (no actions authored on the
 * template, or template === null on an ad-hoc review), inject canonical
 * approve+reject so the recipient is never stranded with no decision
 * affordance. NOT a fallback for the all-filtered case — if an author has
 * deliberately set `expose_to_recipient: false` on every decision action, that
 * intent is respected and the recipient sees no decision buttons.
 */
export function filterTokenActions(
  actions: readonly TemplateActionConfigCanonical[],
): TemplateActionConfigCanonical[] {
  if (actions.length === 0) {
    return normalizeTemplateActions([
      DEFAULT_ACTION_PRESETS.approve,
      DEFAULT_ACTION_PRESETS.reject,
    ]) as TemplateActionConfigCanonical[];
  }
  return actions.filter(
    (a) =>
      a.kind === "decision" &&
      a.expose_to_recipient !== false &&
      a.decision_value !== undefined,
  );
}

/**
 * Force `confirmation: true` on every action regardless of canonical config.
 * The token recipient surface is the lowest-context user surface in the
 * product (no app context, no Cmd+Z, accidental mobile taps, browser-tab
 * children clicking buttons). The 2-step Confirm-then-commit morph is a
 * load-bearing safety guard for this surface specifically; per-action
 * confirmation field semantics apply on the inbox surface where users have
 * full app context.
 *
 * Pure: returns a new array of new objects (caller can mutate without
 * affecting upstream cache; canonical schema fields preserved).
 */
export function withRecipientSafety(
  actions: readonly TemplateActionConfigCanonical[],
): TemplateActionConfigCanonical[] {
  return actions.map((action) => ({ ...action, confirmation: true }));
}

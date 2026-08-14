import {
  DEFAULT_ACTION_PRESETS,
  InvalidRequestError,
  normalizeTemplateActions,
  TemplateActionsCanonicalSchema,
  type TemplateActionConfig,
} from "@gatewerk/shared";

// The field rule itself now lives in @gatewerk/shared so the web editor can
// gate its Publish button on the same implementation the routes enforce
// (S4 defect 2 — the button used to ignore fields entirely and the operator
// met the rule as a 422). Re-exported under the original name so the three
// call sites in routes/templates.ts stay untouched.
export { validateTemplateFields as validateFields } from "@gatewerk/shared";

/**
 * Normalize incoming actions to canonical form, then validate against
 * spec §7.1 rules via TemplateActionsCanonicalSchema. Empty / absent input
 * receives the default [approve, reject] preset pair (spec §3.3).
 *
 * Throws InvalidRequestError on validation failure with a stable error code.
 */
export function normalizeAndValidateActions(actions: unknown): TemplateActionConfig[] {
  const normalized =
    !actions || (Array.isArray(actions) && actions.length === 0)
      ? [{ ...DEFAULT_ACTION_PRESETS.approve }, { ...DEFAULT_ACTION_PRESETS.reject }]
      : normalizeTemplateActions(actions);

  const parsed = TemplateActionsCanonicalSchema.safeParse(normalized);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const issueWithParams = firstIssue as typeof firstIssue & {
      params?: { code?: string };
    };
    const code = issueWithParams.params?.code ?? "invalid_actions";
    const path = firstIssue.path.join(".");
    const field = path.length > 0 ? `actions.${path}` : "actions";
    throw new InvalidRequestError(firstIssue.message, field, code);
  }
  return parsed.data;
}

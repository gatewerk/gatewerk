// Pure-logic helpers for the ActionEditor list view. Extracted from
// ActionEditor.tsx so TemplateDetail can reuse `collectValidation` for
// Publish-button gating without pulling in the React component.
import type { TemplateActionConfigCanonical } from "@gatewerk/shared";

export function collectValidation(
  actions: readonly TemplateActionConfigCanonical[],
): string[] {
  const out: string[] = [];
  const decisions = actions.filter((a) => a.kind === "decision");
  if (decisions.length === 0) {
    out.push("At least 1 decision action required.");
  }
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const a of decisions) {
    if (!a.decision_value) continue;
    if (seen.has(a.decision_value)) dupes.add(a.decision_value);
    seen.add(a.decision_value);
  }
  if (dupes.size > 0) out.push("Decision values must be unique.");
  return out;
}

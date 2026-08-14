// Pure-logic builder for the Export tab. Extracted from DetailJsonTab so the
// shape can be tested without a DOM (the web app has no jsdom/RTL setup — see
// chain-editor-state.test.ts).
//
// S4 ruling: the JSON tab becomes a complete, READ-ONLY export. It emits
// exactly the core-tier
// axes PUT /api/v1/templates/:id accepts — identity, fields, actions, timeout,
// external-links, instructions — plus `chain_config`, which the surface
// declaration counts core even though ChainEditor is its own screen. Nothing
// roadmap-tier is added; that is what keeps this a faithful export rather than
// a second, accidental settings surface (the reasoning S3.5 exists to close
// off).
//
// Two defects this replaces:
//   1. The old read-only view projected every field down to 4 keys, silently
//      dropping `options` — a select field round-tripped as an invalid
//      template.
//   2. It omitted 5 core axes entirely: instructions, timeout_seconds,
//      timeout_action, enable_review_links, chain_config.
import type { TemplateSchema } from "@gatewerk/shared";
import { normalizeToCanonical } from "../_helpers";
import { resolveReviewLinkFields } from "./review-link-helpers";

export function buildTemplateExport(template: TemplateSchema): Record<string, unknown> {
  // enable_review_links is not on the hand-maintained TemplateSchema interface
  // (same reason TemplateDetail.tsx casts via `asRecord`) — draft is passed as
  // null so this always reads the published column, matching every other
  // field in this export.
  const { enableReviewLinks } = resolveReviewLinkFields(null, template as unknown as Record<string, unknown>);

  return {
    slug: template.slug,
    name: template.name,
    description: template.description ?? null,
    instructions: template.instructions ?? null,
    default_priority: template.default_priority,
    timeout_seconds: template.timeout_seconds ?? null,
    timeout_action: template.timeout_action ?? null,
    enable_review_links: enableReviewLinks,
    // `options` is carried through whenever the field actually has it — never
    // dropped, never fabricated for a field type that never carried one.
    // `editable` is unconditional (always present, coerced to boolean) rather
    // than the old only-when-true projection.
    fields: template.fields.map((f) => ({
      name: f.name,
      type: f.type,
      label: f.label,
      ...(f.options !== undefined ? { options: f.options } : {}),
      editable: f.editable === true,
    })),
    // Projected to the four core action axes (id, label, kind, decision_value)
    // rather than emitted whole — the old view over-reported 8 roadmap-tier
    // action keys (webhook_event, requires_feedback, confirmation, style,
    // icon, order, enabled_for_status, expose_to_recipient, description) to
    // anyone who opened the tab. `decision_value` is genuinely absent on
    // iteration/side_effect actions, so it is left to JSON.stringify's normal
    // undefined-key omission rather than forced.
    actions: normalizeToCanonical(template.actions).map((a) => ({
      id: a.id,
      label: a.label,
      kind: a.kind,
      decision_value: a.decision_value,
    })),
    chain_config: template.chain_config ?? null,
  };
}

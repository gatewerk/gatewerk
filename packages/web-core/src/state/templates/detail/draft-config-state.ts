import type { Priority, TemplateField, TemplateActionConfigCanonical } from "@gatewerk/shared";
import { normalizeToCanonical } from "../_helpers";
import {
  resolveReviewLinkFields,
  buildReviewLinkDraftFields,
  type DefaultAuthLevel,
} from "./review-link-helpers";
import { fieldsForSave } from "./field-options-state";

// The template editor's seed → edit → save round trip, extracted from
// TemplateDetail so it can be tested without a DOM (the web app has no
// jsdom/RTL setup — see chain-editor-state.test.ts's note).
//
// Two functions, mirroring the two directions:
//   * `seedEditorState`  wire template → the named state TemplateDetail holds
//   * `buildDraftConfig` that state → the PATCH /:id/draft body
//
// CRITICAL — the editor renders a SUBSET of the template's configuration
// surface (surface tiering: six control groups ship, the rest stay
// reachable over the API only). Values the editor does not render must survive
// being opened and saved, so `buildDraftConfig` spreads a preservation
// baseline FIRST and only then overwrites the keys it actually models.
// Reversing that order silently deletes every roadmap-tier value the operator
// set over the API. Same hazard, same fix as `chain-editor-state.ts`'s
// `_externalTokenRaw` stash.

// Draft keys the publish transaction promotes into the published columns
// (`mappable` in apps/api/src/services/templates.ts). Projected onto the
// baseline so a template that has never carried a draft_config still round
// trips its unmodelled values. Keys the editor models are listed too: they
// cost nothing (state overwrites them) and keeping the list a straight mirror
// of the server's makes drift easier to spot.
//
// `chain_config` is DELIBERATELY absent. ChainEditor writes it straight to the
// template row rather than through the draft, so projecting a possibly stale
// copy into the draft would let a publish resurrect a chain the operator had
// just deleted.
const PROMOTABLE_TEMPLATE_KEYS = [
  "name",
  "description",
  "default_priority",
  "enable_review_links",
  "auto_approve",
  "timeout_seconds",
  "timeout_action",
  "changes_timeout_hours",
  "max_iterations",
  "instructions",
  "allow_request_changes",
  "allow_notes",
  "allow_monitoring",
  "default_auth_level",
  "default_expiry_seconds",
] as const;

// The named state TemplateDetail holds while editing. Numeric inputs are
// strings so partial typing doesn't fight React's value coercion, matching
// WorkingStep in chain-editor-state.ts.
export interface EditorState {
  name: string;
  slug: string;
  description: string;
  priority: Priority;
  fields: TemplateField[];
  actions: TemplateActionConfigCanonical[];
  autoApprove: boolean;
  allowMonitoring: boolean;
  instructions: string;
  timeoutSeconds: string;
  timeoutAction: string;
  changesTimeoutHours: string;
  enableReviewLinks: boolean;
  defaultAuthLevel: DefaultAuthLevel;
  defaultExpirySeconds: number;
}

// Hydrate editor state from a template row. `draft_config` wins per key over
// the published columns, which is what makes an interrupted edit resumable.
// `fromDraft: false` ignores the draft entirely — that is the Discard path,
// where the published columns ARE the intended result.
export function seedEditorState(
  template: Record<string, unknown>,
  opts: { fromDraft?: boolean } = {},
): EditorState {
  const t = template;
  const d = (opts.fromDraft === false ? null : (t.draft_config as Record<string, unknown> | null)) ?? null;
  const rl = resolveReviewLinkFields(d, t);
  return {
    name: (d?.name ?? t.name ?? "") as string,
    slug: (d?.slug ?? t.slug ?? "") as string,
    description: (d?.description ?? t.description ?? "") as string,
    priority: (d?.default_priority ?? t.default_priority) as Priority,
    fields: [...((d?.fields ?? t.fields ?? []) as TemplateField[])],
    actions: normalizeToCanonical(d?.actions ?? t.actions),
    autoApprove: (d?.auto_approve ?? t.auto_approve ?? false) as boolean,
    allowMonitoring: (d?.allow_monitoring ?? t.allow_monitoring ?? false) as boolean,
    instructions: (d?.instructions ?? t.instructions ?? "") as string,
    timeoutSeconds: (d?.timeout_seconds ?? t.timeout_seconds)?.toString() || "",
    timeoutAction: (d?.timeout_action ?? t.timeout_action ?? "expire") as string,
    changesTimeoutHours: (d?.changes_timeout_hours ?? t.changes_timeout_hours)?.toString() || "",
    ...rl,
  };
}

// Snapshot of current edit state shaped for the /draft endpoint.
//
// `template` is not decoration: it supplies the preservation baseline described
// at the top of this file. Callers must pass the SAME row the state was seeded
// from.
export function buildDraftConfig(
  state: EditorState,
  template: Record<string, unknown>,
): Record<string, unknown> {
  const t = template;
  const d = (t.draft_config as Record<string, unknown> | null) ?? null;

  // Published columns first, the last saved draft over them, and only then the
  // controls this editor renders. Anything unmodelled rides through untouched.
  const baseline: Record<string, unknown> = {};
  for (const key of PROMOTABLE_TEMPLATE_KEYS) {
    if (t[key] !== undefined) baseline[key] = t[key];
  }
  if (d) Object.assign(baseline, d);

  // Auto-approve greys the two timeout rows out entirely (DetailEditConfig
  // applies `pointer-events-none`), so the operator cannot see or change them.
  // Writing nulls for controls they cannot reach is the same delete-on-hide
  // hazard as dropping an unmodelled key, so the baseline values stand instead.
  const timeoutFields = state.autoApprove
    ? {}
    : {
      timeout_seconds: state.timeoutSeconds ? Number(state.timeoutSeconds) : null,
      timeout_action: state.timeoutSeconds ? state.timeoutAction : null,
      changes_timeout_hours: state.changesTimeoutHours ? Number(state.changesTimeoutHours) : null,
    };

  return {
    ...baseline,
    slug: state.slug,
    name: state.name,
    description: state.description || null,
    // Unnamed rows and blank option rows are editor scaffolding, not values —
    // `fieldsForSave` drops both and touches nothing else, so an API-set
    // `options` array rides through byte for byte.
    fields: fieldsForSave(state.fields),
    actions: state.actions,
    default_priority: state.priority,
    auto_approve: state.autoApprove,
    allow_monitoring: state.allowMonitoring,
    instructions: state.instructions || null,
    ...timeoutFields,
    ...buildReviewLinkDraftFields({
      enableReviewLinks: state.enableReviewLinks,
      defaultAuthLevel: state.defaultAuthLevel,
      defaultExpirySeconds: state.defaultExpirySeconds,
    }),
  };
}

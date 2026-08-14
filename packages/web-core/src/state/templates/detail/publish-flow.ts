import type { TemplateField, TemplateActionConfigCanonical } from "@gatewerk/shared";
import { validateTemplateFields } from "@gatewerk/shared";
import { collectValidation } from "./action-editor-state";
import { fieldsForSave } from "./field-options-state";

// The Publish gate and the Publish round trip, extracted from TemplateDetail
// so both can be tested without a DOM (the web app has no jsdom/RTL setup —
// see chain-editor-state.test.ts's note).

// Whether Publish is reachable. Both halves matter: the server runs
// `validateFields` AND the canonical action rules on POST /:id/publish, and a
// button that only knew about actions let the operator meet the field rule as
// a 422 (S4 defect 2).
//
// The field list goes through the same `fieldsForSave` normaliser
// `buildDraftConfig` uses, so the gate judges exactly the array the server will
// see. A freshly added, still-unnamed row is not a validation failure — it is a
// row the save drops. Same for a blank option row the operator added and never
// typed into (S4 item 1): the save drops it, so the gate must not count it.
export function canPublishTemplate(
  fields: readonly TemplateField[],
  actions: readonly TemplateActionConfigCanonical[],
): boolean {
  return (
    validateTemplateFields(fieldsForSave(fields)).valid &&
    collectValidation(actions).length === 0
  );
}

// The other half of the gate: whether there is anything TO publish. A
// published template whose layers match has nothing to promote — the server
// would refuse with `no_draft` — so the button must not offer it. A draft is
// always publishable (validity permitting): its first publish is what creates
// the live template at all.
//
// `editedThisSession` exists because `draft_config` alone lags reality by up
// to the autosave debounce: the operator's newest keystrokes live only in
// editor state until the PATCH lands, and a gate reading the row alone would
// block a publish of real changes during that window. (Publish flushes the
// draft before promoting, so allowing it there is safe.)
export function hasPublishableChanges(args: {
  isDraft: boolean;
  hasPersistedDraft: boolean;
  editedThisSession: boolean;
}): boolean {
  return args.isDraft || args.hasPersistedDraft || args.editedThisSession;
}

export interface PublishFlowDeps {
  // Flush the pending draft. Publish promotes draft_config, so this has to
  // land before the publish call or the operator publishes stale content.
  saveDraft: () => Promise<unknown>;
  publish: () => Promise<unknown>;
  setSaving: (saving: boolean) => void;
  setIsEditing: (editing: boolean) => void;
  // The draft flush has no shared error handler; the publish mutation surfaces
  // its own failure through `publishMutationOptions.onError`.
  onDraftError: (error: unknown) => void;
  onPublished: () => void;
}

/**
 * Drive Publish: flush the draft, publish it, and only then leave edit mode.
 *
 * Returns true when the template was published.
 */
export async function runPublish(deps: PublishFlowDeps): Promise<boolean> {
  deps.setSaving(true);

  try {
    await deps.saveDraft();
  } catch (error) {
    deps.onDraftError(error);
    deps.setSaving(false);
    return false;
  }

  try {
    await deps.publish();
  } catch {
    // Helper already surfaced via onError. Edit mode stays open on purpose:
    // the operator has to be looking at the config that was rejected in order
    // to fix it.
    deps.setSaving(false);
    return false;
  }

  // Only here. Leaving edit mode repaints the pane from the PUBLISHED columns,
  // and until the publish call resolves those are the pre-publish values — for
  // a fresh draft, `fields: []` and the name "Untitled template". Closing edit
  // mode first is what made a rejected publish show an empty table, a name the
  // operator never typed, and a toast naming a field they could no longer see.
  deps.setIsEditing(false);
  deps.setSaving(false);
  deps.onPublished();
  return true;
}

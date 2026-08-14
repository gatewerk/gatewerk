import type { FieldType, TemplateField } from "@gatewerk/shared";

// The per-field Configure panel's logic, kept out of DetailFieldsTab so it can
// be tested without a DOM (the web app has no jsdom/RTL setup — see
// chain-editor-state.test.ts's note).
//
// S4 defect 1: the type dropdown offered `select` and nothing anywhere in the
// app could give a select field its options, so picking it produced a template
// that could not publish, rejected by the server with a 422 naming a concept
// absent from the screen.
//
// Every mutator returns a `Partial<TemplateField>` so the caller hands it
// straight to TemplateDetail's `updateField(index, updates)`, the same shape
// the type, name and editable controls already pass.
//
// The publish rule itself is NOT restated here. It lives once in
// packages/shared/src/template-validation.ts and both the server and
// `canPublishTemplate` call it. What this module owns is the array the rule
// judges — see `fieldsForSave`.

// Only `select` takes options. `buttons` reads like it should and does not: the
// shared rule names `select` alone, so surfacing an options editor for any other
// type would offer the operator a control the server ignores. Widening this list
// means widening that rule first.
const OPTION_BEARING_TYPES: readonly FieldType[] = ["select"];

export function typeCarriesOptions(type: FieldType): boolean {
  return OPTION_BEARING_TYPES.includes(type);
}

/**
 * Updates for a type change on the dropdown.
 *
 * Moving TO an option-bearing type seeds an empty array so the shape exists
 * before the operator opens the panel. Empty is deliberate: seeding a blank
 * placeholder entry instead would make the field look satisfied to a
 * length-only rule while carrying nothing a reviewer could pick.
 *
 * Moving AWAY from one deliberately leaves `options` in place. That is the
 * hide-never-delete rule at field level: a template whose select options were
 * set over the API must survive a mis-click on the type dropdown.
 */
export function changeFieldType(field: TemplateField, type: FieldType): Partial<TemplateField> {
  if (typeCarriesOptions(type) && !Array.isArray(field.options)) {
    return { type, options: [] };
  }
  return { type };
}

/** Append an empty row for the operator to type into. */
export function addOption(field: TemplateField): Partial<TemplateField> {
  return { options: [...(field.options ?? []), ""] };
}

/** Rewrite one entry in place, leaving order untouched. */
export function renameOption(field: TemplateField, index: number, value: string): Partial<TemplateField> {
  return { options: (field.options ?? []).map((option, i) => (i === index ? value : option)) };
}

export function removeOption(field: TemplateField, index: number): Partial<TemplateField> {
  return { options: (field.options ?? []).filter((_, i) => i !== index) };
}

/**
 * The options that would actually reach a reviewer: trimmed, blanks dropped.
 *
 * A freshly added row is the empty string, because that is what an editable
 * list has to insert before the operator types. Counting those would let a
 * select field satisfy the publish rule with nothing in it.
 */
export function usableOptions(field: TemplateField): string[] {
  return (field.options ?? []).map((option) => option.trim()).filter((option) => option.length > 0);
}

/** Drives the row's "Needs options" chip, so the problem is visible before Publish. */
export function fieldNeedsOptions(field: TemplateField): boolean {
  return typeCarriesOptions(field.type) && usableOptions(field).length === 0;
}

/**
 * The field array as it will be saved: unnamed rows dropped, blank options
 * dropped.
 *
 * Both the draft save (`buildDraftConfig`) and the Publish gate
 * (`canPublishTemplate`) run through here so the button judges exactly the
 * array the server will judge. Without the options half, clicking "Add option"
 * and typing nothing turned Publish back on, and the template published with a
 * choice a reviewer could see but not read.
 *
 * `options` is never deleted, only emptied — a non-select field carrying an
 * API-set array keeps it.
 */
export function fieldsForSave(fields: readonly TemplateField[]): TemplateField[] {
  return fields.filter((f) => f.name).map(withCleanOptions);
}

function withCleanOptions(field: TemplateField): TemplateField {
  if (!Array.isArray(field.options)) return field;
  const cleaned = usableOptions(field);
  const unchanged =
    cleaned.length === field.options.length &&
    cleaned.every((option, i) => option === field.options![i]);
  return unchanged ? field : { ...field, options: cleaned };
}

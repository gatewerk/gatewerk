// The template `fields[]` rule, in one place.
//
// This used to live in apps/api/src/lib/template-validation.ts and only the
// server ran it, so the editor's Publish button stayed enabled on a config the
// server would reject with a 422 (S4 defect 2). The editor now gates on the
// same function. Copying the rule into the web app instead would have been two
// sources of truth, and the first thing to drift would be the select/options
// case, which the editor is the only place an operator can hit.
//
// Deliberately not Zod: callers want one human-readable sentence naming the
// offending field, and the API surfaces `error` verbatim as the 422 message.
// The Zod shape gate (`TemplateFieldSchema`) runs alongside this in the create
// and update middleware and covers a different class of rule (types, the
// field-name charset).

/**
 * Validate a template's `fields[]` against the three publish-blocking rules:
 * at least one field, unique non-empty names, and a `select` field must carry
 * at least one option.
 *
 * Returns the first violation rather than collecting them all — the API
 * surfaces a single `InvalidRequestError` message and the editor only needs to
 * know whether Publish is reachable.
 */
export function validateTemplateFields(fields: any): { valid: boolean; error?: string } {
  if (!Array.isArray(fields) || fields.length === 0) {
    return { valid: false, error: "A template must have at least one field." };
  }
  const names = new Set<string>();
  for (const field of fields) {
    if (!field.name || typeof field.name !== "string") {
      return { valid: false, error: "Each field must have a 'name' string." };
    }
    if (names.has(field.name)) {
      return { valid: false, error: `Duplicate field name: '${field.name}'. Field names must be unique.` };
    }
    names.add(field.name);
    if (field.type === "select" && (!field.options || !Array.isArray(field.options) || field.options.length === 0)) {
      return { valid: false, error: `Select field '${field.name}' must have at least one option.` };
    }
  }
  return { valid: true };
}

// Server-side enforcement of `field.editable`.
//
// `editable` was a client-side gate only: the inbox and the external recipient
// page rendered an edit affordance for editable fields, and the server accepted
// whatever `edited_payload` arrived. `execute-action.ts` wrote it straight into
// `edited_payload` and `approved_value` — and `approved_value` is the value the
// agent consumes from the decision webhook, and the payload a chain carries to
// its next step. So the template's declaration of what a reviewer may change
// was advisory.
//
// The actor that makes this matter is not the reviewer. Minting an external
// review link needs `enable_review_links` plus a recipient-exposed decision
// action, but once minted, a default `auth_level: 'public'` link is
// UNAUTHENTICATED: no account, no cookie, no email. Handing someone a link so
// they can approve a deploy is not consent to rewrite the deploy's parameters.
//
// DIFF, DO NOT FILTER
// -------------------
// Both frontends submit the WHOLE payload as `edited_payload`
// (`{...payload, ...edits}`), not just the touched keys. So:
//   * rejecting on the mere PRESENCE of a non-editable key would 422 every
//     ordinary submit from the shipping UI;
//   * silently FILTERING non-editable keys out would erase every untouched key
//     from `approved_value` and hand the agent a truncated payload — turning a
//     validation problem into data loss.
// The only correct reading is: a key may appear freely, but its VALUE may only
// differ from the stored payload if the template marked that field editable.
// An unchanged echo is always fine; a changed value on a non-editable field is
// always refused, loudly.

import { InvalidRequestError } from "@gatewerk/shared";

export interface EditableFieldSpec {
  name: string;
  editable?: boolean;
}

/**
 * Structural comparison for JSON-shaped payload values. Key order is
 * insignificant, so a client that reserialises an object it received back to us
 * is treated as having changed nothing.
 */
export function jsonValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonValuesEqual(item, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) => Object.prototype.hasOwnProperty.call(bObj, k) && jsonValuesEqual(aObj[k], bObj[k]),
  );
}

/**
 * Names whose value the caller actually changed relative to the stored payload
 * and which the template does not mark editable. A key absent from the field
 * list entirely is never editable, which also blocks injecting keys the
 * template never declared (including the `_media_<field>` descriptors
 * `crud.ts` writes, where a forged `stored_path` would repoint a served
 * object).
 */
export function findNonEditableChanges(
  editedPayload: Record<string, unknown>,
  basePayload: Record<string, unknown> | null | undefined,
  fields: readonly EditableFieldSpec[] | null | undefined,
): string[] {
  const editable = new Set(
    (fields ?? []).filter((f) => f?.editable === true).map((f) => f.name),
  );
  const base = basePayload ?? {};

  return Object.keys(editedPayload)
    .filter((key) => !editable.has(key))
    .filter((key) => !jsonValuesEqual(editedPayload[key], (base as Record<string, unknown>)[key]));
}

/**
 * Throws unless every changed key in `editedPayload` is editable per the
 * template. Field specs should come from the review's creation-time
 * `template_fields` snapshot so a later template edit cannot retroactively
 * widen or narrow what an in-flight review accepts; callers fall back to the
 * live template row only for pre-snapshot rows.
 */
export function assertEditedPayloadAllowed(
  editedPayload: Record<string, unknown> | null | undefined,
  basePayload: Record<string, unknown> | null | undefined,
  fields: readonly EditableFieldSpec[] | null | undefined,
): void {
  if (!editedPayload) return;

  const offenders = findNonEditableChanges(editedPayload, basePayload, fields);
  if (offenders.length === 0) return;

  const names = offenders.sort().join(", ");
  throw new InvalidRequestError(
    `These fields are not editable on this template and cannot be changed: ${names}. Submit them unchanged, or mark them editable on the template.`,
    "edited_payload",
    "field_not_editable",
  );
}

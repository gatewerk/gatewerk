/**
 * Turning staged inline edits into the `edited_payload` a decision carries.
 *
 * Two properties matter and both are load bearing:
 *
 *   1. The wire value is the WHOLE merged payload, not a diff. The server
 *      persists it as the reviewed version of the request, so a diff would
 *      record a review of a payload that never existed.
 *   2. It is omitted entirely when nothing is staged — not sent as `{}`. An
 *      untouched approval must stay byte-identical to what it sends today,
 *      because `{}` would read as "the reviewer emptied every field".
 *
 * Shape mirrors apps/web/src/pages/inbox/use-action-feedback-state.ts:76-89,
 * which is the tested precedent this app is replacing.
 */

export function mergeEditedPayload(
  originalPayload: Record<string, unknown> | null | undefined,
  staged: ReadonlyMap<string, unknown>,
): Record<string, unknown> | undefined {
  if (staged.size === 0) return undefined;
  return { ...(originalPayload ?? {}), ...Object.fromEntries(staged) };
}

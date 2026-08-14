/**
 * Tag input model — pure functions behind TagInput.tsx.
 *
 * The server enforces [a-z0-9][a-z0-9_-]{0,31} and a cap (NOTE_TAGS_MAX in
 * packages/shared/src/api/schemas/notes.ts). This module lowercases and
 * trims so a stray space is not a failed write, and stops there: an invalid
 * tag goes to the server and comes back with the server's own message,
 * rather than being silently dropped and losing what the author typed.
 *
 * TAGS_MAX mirrors NOTE_TAGS_MAX from packages/shared/src/api/schemas/notes.ts
 * (confirmed 10 as of this task). Kept as a local constant rather than an
 * import so this screen module has no dependency on the shared package's
 * schema internals; if the server cap changes, this constant changes with it.
 */
export const TAGS_MAX = 10;

export function normaliseTag(raw: string): string {
  return raw.trim().toLowerCase();
}

export function suggestTags(all: string[], selected: string[], typed: string): string[] {
  const q = normaliseTag(typed);
  return all.filter((t) => !selected.includes(t) && (!q || t.includes(q)));
}

export function canAddTag(selected: string[], candidate: string): boolean {
  const t = normaliseTag(candidate);
  if (!t) return false;
  if (selected.includes(t)) return false;
  return selected.length < TAGS_MAX;
}

/**
 * Whether the suggestion dropdown is actually visible on screen right now.
 * This is the single source of truth for two decisions in TagInput.tsx that
 * must never disagree: whether to render the dropdown, and whether an
 * Escape keypress gets caught here (closing it) instead of bubbling out to
 * the composer's own Escape handling.
 *
 * `open` alone is not enough: TagInput sets it true on bare `onFocus`, before
 * anything is typed, which is a state with nothing rendered. Gating Escape
 * on `open` swallowed the keypress with no visible effect, so cancelling the
 * whole form took two presses instead of one (feedback_escape_cancel: Escape
 * cancels the nearest thing, once).
 */
export function tagDropdownVisible(
  suggestions: string[],
  selected: string[],
  typed: string,
  open: boolean,
): boolean {
  if (!open) return false;
  const matches = suggestTags(suggestions, selected, typed);
  const query = normaliseTag(typed);
  const canCreate = query.length > 0 && !suggestions.includes(query) && !selected.includes(query);
  return matches.length > 0 || canCreate;
}

/**
 * TagInput's own fixed height. Empty, the field's
 * box (padding 9px×2 + border) renders at ~39.5px — a bare text line at this
 * app's shared 1.5 line-height. A chip (padding 4px×2 + its own 11px line at
 * 16.5px + its own 1px×2 border = 26.5px) is taller than that line, so
 * without a floor the box grew ~7px the instant the first tag landed. This
 * is derived from the field's OWN chip styling (TagInput.tsx), not borrowed
 * from a neighbouring field: a floor sized to a plain-text sibling (the
 * Heading field, ~40px) still isn't tall enough to hold a chip.
 *
 * Round 3 finding: a floor alone only holds for ONE row — `flex-wrap` let a
 * SECOND row of chips grow the field again once enough tags wrapped at this
 * column's width, deferring the exact shift rather than
 * removing it, and it would have started firing at the TAGS_MAX cap. The
 * fix is `tagFieldLayout`'s `wrap: "nowrap"`: TagInput.tsx renders the chips
 * on one line that scrolls horizontally (`overflow-x-auto`) instead of
 * wrapping, so the row can never grow a second line no matter how many tags
 * exist — confirmed live in the running app at 0 and at TAGS_MAX (10) tags,
 * both measuring the same height. 47 (rounded up from the 46.5px a single
 * row with a chip needs) budgets enough headroom to also cover the
 * horizontal scrollbar's own reserved gutter once ten tags actually
 * overflow the column.
 */
export const TAG_FIELD_HEIGHT = 47;

export interface TagFieldLayout {
  height: number;
  wrap: "nowrap";
}

/**
 * The tag field's layout decision, pure and testable rather than eyeballed
 * (fix round 3): `count` is accepted so the invariant itself — same height,
 * never wraps, at ANY tag count from 0 through TAGS_MAX — is what the test
 * suite pins, not just today's constant. TagInput.tsx calls this rather than
 * hardcoding `TAG_FIELD_HEIGHT`/`nowrap` inline, so a future change that
 * reintroduces count-dependent height (e.g. bringing `flex-wrap` back) has
 * to edit this function, and its own test, to do it.
 */
export function tagFieldLayout(_count: number): TagFieldLayout {
  return { height: TAG_FIELD_HEIGHT, wrap: "nowrap" };
}

/**
 * "Advance to next item" for the Inbox (Cmd+Enter in the reply composer,
 * or the decision rail once it grows the same shortcut). Deliberately no
 * wraparound — reaching the end of the open queue should feel like
 * finishing it, not looping back to the top unannounced.
 */
export function getNextItemId(
  items: { id: string }[],
  currentId: string | null,
): string | null {
  if (currentId === null) return null;
  const index = items.findIndex((item) => item.id === currentId);
  if (index === -1) return null;
  return items[index + 1]?.id ?? null;
}

/**
 * Where the detail pane goes once a review has been decided.
 *
 * The decided review leaves the open queue, so leaving it on screen shows a
 * reviewer a card they can no longer act on, beside a list that has already
 * forgotten it. Move to the next one in the queue, and when there is nothing
 * after it fall back to the one before, so finishing the last item in a run
 * does not dump the reviewer on an empty pane while work remains above.
 *
 * Returns null when the queue holds nothing else, which the caller reads as
 * "clear the selection". Also returns null when the decided id is already
 * gone from `items`, because the caller cannot then say where the reviewer
 * was, and guessing would jump them somewhere they never chose.
 */
export function getIdAfterDecision(
  items: { id: string }[],
  decidedId: string | null,
): string | null {
  if (decidedId === null) return null;
  const index = items.findIndex((item) => item.id === decidedId);
  if (index === -1) return null;
  return items[index + 1]?.id ?? items[index - 1]?.id ?? null;
}

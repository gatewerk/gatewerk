/**
 * Reply composer key semantics: plain Enter
 * submits and stays on this item — today's existing behavior, unchanged.
 * Shift+Enter inserts a newline, now that the composer is a real multi-line
 * textarea (AutoGrowTextarea) instead of a single-line input. Cmd/Ctrl+Enter
 * submits AND advances to the next open item, matching the original ask
 * ("cmd+enter to go to the next row").
 */
export type ReplyKeydownAction = "submit" | "submit-and-advance" | "newline" | "none";

export function classifyReplyKeydown(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): ReplyKeydownAction {
  if (e.key !== "Enter") return "none";
  if (e.metaKey || e.ctrlKey) return "submit-and-advance";
  if (e.shiftKey) return "newline";
  return "submit";
}

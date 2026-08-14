/**
 * NoteRow — one note in the notes list.
 *
 * Row shell, selection treatment and hover copied verbatim from
 * HistoryRow.tsx:42-49 (11px/13px padding, r11, an always-present border so
 * selecting a row never shifts the list, a neutral selected fill — never
 * green, per HistoryRow.tsx's file comment lines 11-15).
 *
 * No avatar and no visibility marker on the row: author belongs in the
 * detail pane (task-2-brief.md), and a note being shared or private is a
 * configuration fact, which gets no colour, no dot and no badge (task
 * brief, global constraints — the previous version of this screen coloured
 * that distinction and that was ruled wrong). Private is the default and
 * renders as nothing.
 */
import type { Note } from "@gatewerk/web-core/api/notes";
import { timeAgo } from "@gatewerk/web-core/lib/utils";
import { noteExcerpt } from "./notes-model";
import { pinKindLabel } from "./pin-picker-model";

interface Props {
  note: Note;
  isSelected: boolean;
  onClick: () => void;
  /**
   * Accepted for interface symmetry with the rest of the notes screen (and
   * a future author affordance in the detail pane). The row itself never
   * shows an author — no avatar on the row, per the brief — so it goes
   * unused here.
   */
  currentUserId: string | undefined;
}

/**
 * First pin's kind, plus "+N" when there is more than one.
 *
 * The row has no data to resolve a pin's real title with, so it names the
 * kind instead (brief, resolved ambiguity). pinKindLabel is shared with the
 * composer so the two never drift apart (pin-picker-model.ts).
 */
function pinSummary(attachments: Note["attachments"]): string {
  const kind = pinKindLabel(attachments[0].target_kind);
  return attachments.length > 1 ? `${kind} +${attachments.length - 1}` : kind;
}

export function NoteRow({ note, isSelected, onClick }: Props) {
  // Order: tags, then what it's pinned to, then relative time (brief,
  // resolved ambiguity). Built as parts and filtered rather than the
  // brief's literal template-string concatenation so an empty tag list or
  // no attachments doesn't leave a stray leading space in the line.
  const metaParts = [
    note.tags.length > 0 ? note.tags.map((t) => `#${t}`).join(" ") : null,
    note.attachments.length > 0 ? `on ${pinSummary(note.attachments)}` : null,
    timeAgo(note.created_at),
  ].filter((part): part is string => part != null);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isSelected ? "true" : undefined}
      className="w-full cursor-pointer rounded-[11px] text-left transition-colors hover:bg-[rgba(var(--gw-line-rgb),.03)]"
      style={{
        padding: "11px 13px",
        background: isSelected ? "rgba(var(--gw-hi-rgb),.045)" : undefined,
        border: isSelected
          ? "1px solid rgba(var(--gw-line-rgb),.09)"
          : "1px solid transparent",
      }}
    >
      {/* Excerpt takes the row title's type treatment (HistoryRow.tsx:52-60:
          14px, weight 550 / 600 selected, t4 / t1 selected) but clamps to
          two lines instead of truncating to one — a note's first line of
          prose runs longer than a review title. */}
      <span
        className="block"
        style={{
          fontSize: 14,
          fontWeight: isSelected ? 600 : 550,
          color: isSelected ? "var(--gw-t1)" : "var(--gw-t4)",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {noteExcerpt(note.body)}
      </span>

      {/* Meta line: lowercase mono, parts separated by space alone, no
          middots (size/margin/colour from HistoryRow.tsx:67-76). */}
      <span
        className="block min-w-0 truncate font-mono"
        style={{
          marginTop: 7,
          fontSize: 11,
          color: isSelected ? "var(--gw-t6)" : "var(--gw-t8)",
        }}
      >
        {metaParts.join(" ")}
      </span>
    </button>
  );
}

/**
 * NotesCollapsedStrip — the 54px collapsed list strip: expand button plus one
 * dot per note in the currently filtered list, same shell as History's
 * minimap (History.tsx:214-278). Notes carries no per-row role to tint by
 * (History's destructive/neutral colouring comes from a review's decision,
 * which a note has no equivalent of), so every dot uses the neutral
 * treatment History reserves for its own default rows. Capped at 24, same as
 * History.tsx:240's `visible.slice(0, 24)` — without the cap, this screen's
 * 100 item page size could pour far more dots into the strip than History
 * ever does (fix round 1, Finding 2).
 *
 * Split out of Notes.tsx into its own file purely to keep that file under
 * the notes module's 300-line cap (eslint.config.mjs's
 * gatewerk/notes-module-300-line-cap) — the same reason NotesListHeader.tsx's
 * own file comment gives for splitting out NotesFilterPopover.tsx. Desktop
 * only: it is never reached on a phone (Notes.tsx's narrow branch returns
 * before this width-constrained column renders at all).
 */
import type { Note } from "@gatewerk/web-core/api/notes";

interface Props {
  notes: Note[];
  isLoading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onExpand: () => void;
}

export function NotesCollapsedStrip({ notes, isLoading, selectedId, onSelect, onExpand }: Props) {
  return (
    <div className="flex h-full flex-col items-center gap-1 py-[14px]">
      <button
        type="button"
        onClick={onExpand}
        title="Expand list"
        className="mb-1.5 flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-[9px] border-none bg-transparent text-t8 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)] hover:text-t4"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="9.5" y1="4" x2="9.5" y2="20" strokeDasharray="2 2" />
        </svg>
      </button>

      {!isLoading &&
        notes.slice(0, 24).map((n) => {
          const isSelected = selectedId === n.id;
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => onSelect(n.id)}
              title={n.body.slice(0, 80)}
              className="flex w-[38px] shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-none transition-colors"
              style={{
                height: isSelected ? 30 : 28,
                background: isSelected ? "rgba(var(--gw-line-rgb),.08)" : "transparent",
                boxShadow: isSelected ? "inset 0 0 0 1px rgba(var(--gw-line-rgb),.09)" : "none",
              }}
            >
              <span
                style={{
                  display: "block",
                  width: isSelected ? 8 : 7,
                  height: isSelected ? 8 : 7,
                  borderRadius: "50%",
                  background: isSelected ? "var(--gw-t3)" : "rgba(var(--gw-line-rgb),.28)",
                }}
              />
            </button>
          );
        })}
    </div>
  );
}

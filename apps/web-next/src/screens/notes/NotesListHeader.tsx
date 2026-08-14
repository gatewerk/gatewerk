/**
 * NotesListHeader — the list column's header block: visibility tabs, the tag
 * funnel trigger and its filter popover, the collapse button, then search.
 *
 * THE MOST IMPORTANT INSTRUCTION for this file (task-2-brief.md): the notes
 * screen must be visually indistinguishable in chrome from History. Every
 * structural piece below is HistoryListHeader.tsx's, cited by line.
 *
 * One deliberate departure from the task brief's own pseudocode: the brief's
 * Step 2 snippet lists ListSearchField before SegmentedTabs, but
 * HistoryListHeader.tsx actually renders the tabs/trigger/collapse row
 * first (lines 122-444) and the search field second (lines 446-453). Since
 * the overriding rule is visual parity with History's real chrome, not with
 * the brief's illustrative snippet, this file follows the source file's
 * order.
 *
 * The funnel's popover here has two sections, Tags and Date range, instead
 * of History's three (archived / template / date range) — notes carry no
 * archived state and no template axis. The Tags section still renders
 * nothing when `tags.length === 0` (a filter with no options is chrome for a
 * behaviour that cannot happen, brief's resolved ambiguity), but the trigger
 * and popover themselves are no longer gated on tags existing: Date range
 * is always a real filter, even on a project with zero tags.
 *
 * A time filter, using the app's existing date
 * range language rather than a new control. The Date range section below —
 * preset chips plus a custom-range calendar disclosure — is
 * HistoryListHeader.tsx:242-417 ported verbatim (state, markup, and the
 * `pickDay`/`applyDatePreset` shapes History.tsx:171-185 uses), because
 * floating-layer date pickers are one language app-wide, same as the Tags
 * section already borrows the funnel/popover chrome from that file. The
 * single "Clear all" at the top (History's own pattern) now clears both
 * sections, replacing the old per-tag "Clear" — a popover clear that left
 * the date filter on would be worse than no clear at all.
 *
 * The popover's own body (Tags, Date range, and their shared "Clear all")
 * lives in NotesFilterPopover.tsx, split out purely to keep this file under
 * the notes module's 300-line cap (eslint.config.mjs's
 * gatewerk/notes-module-300-line-cap) — the popover markup alone exceeded it.
 * This file keeps the trigger button, its green dot, and the Escape handler
 * that closes the popover; NotesFilterPopover.tsx owns everything inside it.
 */

import { useEffect, useState, type RefObject } from "react";
import { Plus } from "lucide-react";
import { SegmentedTabs } from "~/components/SegmentedTabs";
import { ListSearchField } from "~/components/ListSearchField";
import { VISIBILITY_TABS, type Visibility } from "./notes-model";
import { NotesFilterPopover } from "./NotesFilterPopover";

interface Props {
  query: string;
  onQueryChange: (query: string) => void;
  visibility: Visibility;
  onVisibilityChange: (visibility: Visibility) => void;
  tags: string[];
  activeTag: string | null;
  onTagChange: (tag: string | null) => void;
  /** Preset day-count key ("today", "7d", …) from DATE_PRESETS, or null when a custom/no range is active. */
  datePreset: string | null;
  onDatePreset: (key: string | null) => void;
  dateFrom: string;
  dateTo: string;
  onPickDay: (iso: string) => void;
  /** Clears tag AND date range — everything the funnel popover itself controls, not query or visibility. */
  onClearFilters: () => void;
  /** Whether the funnel's green active-filter dot should show: tag or any part of the date range is set. */
  filterActive: boolean;
  /**
   * Fix round 1, Finding 1: the resting pane's composer is reachable by
   * deselecting the current note, but a hidden second click on an already
   * selected row is not discoverable by a first time user. This is the
   * explicit, always visible way in, regardless of what is currently
   * selected.
   */
  onNewNote: () => void;
  /** Collapse the list column to the 54px strip (the only collapse control, HistoryListHeader.tsx:57). */
  onCollapse: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

export function NotesListHeader({
  query,
  onQueryChange,
  visibility,
  onVisibilityChange,
  tags,
  activeTag,
  onTagChange,
  datePreset,
  onDatePreset,
  dateFrom,
  dateTo,
  onPickDay,
  onClearFilters,
  filterActive,
  onNewNote,
  onCollapse,
  inputRef,
}: Props) {
  const [filterOpen, setFilterOpen] = useState(false);

  // Escape closes the popover, at capture, per HistoryListHeader.tsx:86-109
  // — a bubble-phase listener would lose the race to useZen's own
  // document-level Escape handler and drop the whole shell out of zen mode.
  useEffect(() => {
    if (!filterOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setFilterOpen(false);
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [filterOpen]);

  return (
    <div className="flex flex-col gap-[11px] px-3 pb-[11px] pt-[15px]">
      {/* ── Tabs + trigger row (HistoryListHeader.tsx:120-126) ── */}
      <div className="flex items-center gap-2">
        <SegmentedTabs
          tabs={VISIBILITY_TABS}
          active={visibility}
          onChange={onVisibilityChange}
          ariaLabel="Filter notes by who can see them"
        />

        {/* Funnel trigger, no longer gated on tags existing (fix round 3):
            Date range is always a real filter even on a project with zero
            tags, so hiding the whole trigger for that case would hide a
            working filter, not chrome for a behaviour that cannot happen. */}
        <div className="relative flex shrink-0 items-center">
          {/* Funnel trigger, verbatim (HistoryListHeader.tsx:128-167). */}
          <button
            type="button"
            title="Filter"
            aria-haspopup="dialog"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen((o) => !o)}
            className={
              filterOpen
                ? "relative flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-[8px] border-none bg-[rgba(var(--gw-line-rgb),0.10)] text-t2 transition-colors"
                : "relative flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-[8px] border-none bg-transparent text-t8 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)] hover:text-t4"
            }
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
            >
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46" />
            </svg>
            {filterActive && (
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  top: 5,
                  right: 5,
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--gw-green)",
                }}
              />
            )}
          </button>

          {filterOpen && (
            <NotesFilterPopover
              tags={tags}
              activeTag={activeTag}
              onTagChange={onTagChange}
              datePreset={datePreset}
              onDatePreset={onDatePreset}
              dateFrom={dateFrom}
              dateTo={dateTo}
              onPickDay={onPickDay}
              onClearFilters={onClearFilters}
              filterActive={filterActive}
              onClose={() => setFilterOpen(false)}
            />
          )}
        </div>

        {/* New note — same 30x30/rounded-8 icon button box as the funnel
            trigger and the collapse button below (both HistoryListHeader.tsx
            treatments, cited above and at HistoryListHeader.tsx:424-443), so
            it reads as one family of row actions rather than a bolted-on
            control sized by eye. Fix round 1, Finding 1. */}
        <button
          type="button"
          title="New note"
          aria-label="Write a new note"
          onClick={onNewNote}
          className="flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-none bg-transparent text-t8 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)] hover:text-t4"
        >
          <Plus size={15} strokeWidth={1.9} />
        </button>

        {/* Collapse list — panel icon, verbatim (HistoryListHeader.tsx:424-443). */}
        <button
          type="button"
          title="Collapse list"
          onClick={onCollapse}
          className="flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-none bg-transparent text-t8 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)] hover:text-t4"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <rect x="3" y="4" width="6.5" height="16" rx="2" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>

      {/* ── Search (HistoryListHeader.tsx:446-453) ── */}
      <ListSearchField
        value={query}
        onChange={onQueryChange}
        placeholder="Search notes"
        ariaLabel="Search notes"
        inputRef={inputRef}
      />
    </div>
  );
}

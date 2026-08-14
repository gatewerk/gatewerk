/**
 * Notes — team context, pinned to templates from this screen. A note
 * created through the API or by an agent can still carry a review or chain
 * run pin, which this screen still renders (NotePinCard.tsx).
 *
 * Two panes. THE BINDING REQUIREMENT (task-3-brief.md): this screen's chrome
 * must be indistinguishable from History's. The list column width and its
 * collapsed width, the transition classes, the zen and manual collapse
 * behaviour, the scroll container and the detail card surface are all copied
 * from apps/web-next/src/screens/history/History.tsx, cited by line at each
 * site below. Bucket headers use RulerTickHeader (task brief, Step 3) rather
 * than History's own inline markup — RulerTickHeader's file comment records
 * that it was extracted FROM History precisely so other screens would not
 * re-derive its header by hand, which is what using it here honours.
 *
 * Review replies are notes carrying THREAD_TAG and belong to the review's
 * activity thread, not this shelf — excludeThreadNotes (notes-model.ts)
 * drops them before anything else touches the list.
 *
 * Selection falls back to the resting pane (NoteRestingPane, task 8) rather
 * than showing a stale note whenever the selected id no longer appears in
 * the currently filtered list — deleted, or filtered away, are the same case
 * (task brief, resolved ambiguity).
 *
 * Judgment call beyond the brief's literal pseudocode: clicking the already
 * selected row deselects it. Nothing else in the built screen (not
 * NotesListHeader, not this file's own pseudocode) offers a "new note"
 * trigger, and NoteRestingPane's own file comment is explicit that the
 * resting pane's composer IS how a note gets written on this screen. Without
 * a toggle-off, selecting any note would make composing a second one
 * unreachable without a full page reload.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { ZenOutletContext } from "~/shell/use-zen";
import { StickyNote } from "lucide-react";
import type { Note } from "@gatewerk/web-core/api/notes";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { projectSettingsQuery, notesListQuery } from "~/route-queries";
import { RulerTickHeader } from "~/components/RulerTickHeader";
import { useSlashFocus } from "~/components/use-slash-focus";
import { EmptyStateTier1, EmptyStateTier2, SearchTerm } from "~/components/empty-state";
import { SkeletonRows } from "~/components/skeleton";
import {
  allTags,
  bucketNotes,
  excludeThreadNotes,
  filtersForCreatedNote,
  noteTitle,
  visibleNotes,
  type Visibility,
} from "./notes-model";
import { NotesListHeader } from "./NotesListHeader";
import { NotesCollapsedStrip } from "./NotesCollapsedStrip";
import { NoteRow } from "./NoteRow";
import { NoteDetail } from "./NoteDetail";
import { NoteRestingPane } from "./NoteRestingPane";
import { useNarrowViewport } from "~/shell/use-narrow-viewport";
import { MobilePane } from "../mobile/MobilePane";
import { usePaneSelection } from "../mobile/use-pane-selection";

/**
 * Notes selection lives in `?note=`, not useState — the same
 * move as History (History.tsx's own selectedIdFromParams file comment) and
 * for the same load bearing reason: on a phone the detail takes the whole
 * screen, so the back gesture has to return to the list, which local state
 * cannot do.
 */
/**
 * Sentinel value for `?note=`, meaning "the composer", not a note.
 *
 * Real note ids are prefixed `gw_note_`, so this cannot collide with one.
 * Riding the existing param keeps the phone composer on the same push and pop
 * machinery as a note detail, instead of a second state the back gesture
 * cannot see.
 */
export const COMPOSE_ID = "new";

export function selectedNoteIdFromParams(params: URLSearchParams): string | null {
  return params.get("note") || null;
}

export function Notes() {
  useEffect(() => {
    document.title = "Notes · Gatewerk";
  }, []);

  const { user } = useAuth();
  const { zen } = useOutletContext<ZenOutletContext>();
  // Zen forces the list shut without discarding the reviewer's own choice —
  // it reappears at whatever manual state it was in once zen ends
  // (History.tsx:58-61).
  const [manualListCollapsed, setManualListCollapsed] = useState(false);
  const listCollapsed = manualListCollapsed || zen;

  const [visibility, setVisibility] = useState<Visibility>("all");
  const [tag, setTag] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The list header's Date range popover section, filtering on created_at —
  // History's own preset/from-to shape (matchesNotesDate, notes-model.ts),
  // ANDed with visibility, tag and search like every other filter here.
  const [datePreset, setDatePreset] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const narrow = useNarrowViewport();
  // Selection lives in the URL (?note=<id>) so refresh, back, and shared links
  // restore it — see selectedNoteIdFromParams above. usePaneSelection owns
  // the one thing that differs by width: on a phone the detail is the whole
  // screen, so opening one has to push a history entry or the back gesture
  // skips the list and leaves the screen entirely (History.tsx's own
  // precedent).
  const { selectedId, select: setSelectedId, close: closeDetail } = usePaneSelection(
    "note",
    narrow,
  );
  // Phone only. The composer is the resting state of this screen's detail
  // pane on a laptop (NoteRestingPane.tsx's own file comment, a deliberate
  // exception to chrome doctrine), but that does not map onto one pane at a
  // time: with nothing selected, a phone shows the list, not a form. This
  // is the explicit "New note" trigger's target instead (NotesListHeader's
  // onNewNote, wired below).
  //
  // It rides the SAME `?note=` param as a real selection, under the sentinel
  // COMPOSE_ID, rather than being a second piece of local state. Held in
  // useState it was invisible to history, so the back gesture did not close
  // the composer, it left Notes altogether and threw away a half written
  // note. One mechanism means the composer gets push, pop and the cold deep
  // link for free, exactly like a note detail. Note ids are `gw_note_…`, so
  // the sentinel cannot collide with one.
  const composing = selectedId === COMPOSE_ID;
  const setComposing = useCallback(
    (on: boolean) => setSelectedId(on ? COMPOSE_ID : null),
    [setSelectedId],
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const projectQuery = useQuery(projectSettingsQuery);
  const projectId = projectQuery.data?.id ?? null;

  const listQuery = useQuery({ ...notesListQuery(projectId ?? ""), enabled: !!projectId });

  const items = useMemo(() => excludeThreadNotes(listQuery.data?.items ?? []), [listQuery.data]);
  const tags = useMemo(() => allTags(items), [items]);

  // `now` captured once per recompute and shared between the date filter and
  // the date buckets below, History.tsx's own rule (History.tsx:126-129):
  // filtering "today" against one instant and bucketing "today" against a
  // different one is the classic way the two disagree at the edges.
  const { shown, buckets } = useMemo(() => {
    const now = new Date();
    const shownList = visibleNotes(items, visibility, tag, query, {
      preset: datePreset,
      from: dateFrom,
      to: dateTo,
      now,
    });
    return { shown: shownList, buckets: bucketNotes(shownList, now) };
  }, [items, visibility, tag, query, datePreset, dateFrom, dateTo]);

  // Popover's green dot and its own "Clear all": tag and date range are the
  // two things that popover controls. Visibility and search live outside it
  // and are not part of this.
  const filterActive = !!tag || !!datePreset || !!dateFrom || !!dateTo;

  // Falls back to the resting pane rather than rendering a stale note: a
  // selection that no longer appears in the filtered list (deleted, or
  // filtered away) must not keep showing its old detail pane.
  const selected = shown.find((n) => n.id === selectedId) ?? null;

  useSlashFocus(inputRef);

  const isLoading = projectQuery.isLoading || listQuery.isLoading;
  const error = listQuery.error;

  // Tier 2 empty state's reset. Must clear every filter that can hide a note
  // — the date range included, or "Clear filters" would leave one filter on,
  // which is worse than no reset at all.
  function clearEverything() {
    setQuery("");
    setTag(null);
    setVisibility("all");
    setDatePreset(null);
    setDateFrom("");
    setDateTo("");
  }

  // The funnel popover's own "Clear all" (History.tsx:187-193's pattern): only
  // the two things that popover controls, tag and date range. Query and
  // visibility live outside it and are untouched here.
  function clearFilters() {
    setTag(null);
    setDatePreset(null);
    setDateFrom("");
    setDateTo("");
  }

  // Calendar day pick, History.tsx:171-179 verbatim: first click starts a
  // range, a second finishes it (swapping if picked out of order), and a
  // third click over a completed range starts a new one instead of extending
  // it. Picking a day always clears any active preset — the two are mutually
  // exclusive ways of expressing the same filter.
  function pickDay(iso: string) {
    if (!dateFrom || (dateFrom && dateTo)) {
      setDateFrom(iso);
      setDateTo("");
      setDatePreset(null);
    } else if (iso < dateFrom) {
      setDateTo(dateFrom);
      setDateFrom(iso);
      setDatePreset(null);
    } else {
      setDateTo(iso);
      setDatePreset(null);
    }
  }

  // Picking a preset clears any custom range in progress, History.tsx:181-185
  // verbatim — preset and custom range are mutually exclusive.
  function applyDatePreset(key: string | null) {
    setDatePreset(key);
    setDateFrom("");
    setDateTo("");
  }

  // Creating a note has to end with that note on screen. Selection resolves
  // against the FILTERED list, so with any filter active that excludes the new
  // note the selection resolved to nothing: the resting pane stayed mounted
  // holding the whole draft, under a toast saying the note was created, and
  // pressing Create note again wrote a second copy (fix round 2, Finding 2).
  // filtersForCreatedNote (notes-model.ts) clears only the filters that would
  // exclude it, so a narrowing the note satisfies survives. Now covers the
  // date range too: a note written while an old range was still active would
  // otherwise be saved and never appear, the same bug class in a new filter.
  function selectCreatedNote(note: Note) {
    const next = filtersForCreatedNote(
      note,
      { visibility, tag, query, datePreset, dateFrom, dateTo },
      new Date(),
    );
    setVisibility(next.visibility);
    setTag(next.tag);
    setQuery(next.query);
    setDatePreset(next.datePreset);
    setDateFrom(next.dateFrom);
    setDateTo(next.dateTo);
    setSelectedId(note.id);
    // Creating from the phone's compose button lands on the new note's
    // detail, not back on an empty compose screen.
    setComposing(false);
  }

  // Header + rows, factored out of the desktop expanded column so a phone
  // can reuse it full width without duplicating the list body (loading/
  // error/empty/buckets) — History.tsx's own renderListColumn factoring.
  // `onNewNote` differs by width: on a laptop it deselects, which reveals
  // the resting pane's composer in place (NoteRestingPane.tsx); on a phone
  // there is no resting composer to reveal, so it opens the compose screen
  // instead (see `composing` above).
  function renderListColumn() {
    return (
      <div className="flex h-full min-w-0 flex-col">
        <NotesListHeader
          query={query}
          onQueryChange={setQuery}
          visibility={visibility}
          onVisibilityChange={setVisibility}
          tags={tags}
          activeTag={tag}
          onTagChange={setTag}
          datePreset={datePreset}
          onDatePreset={applyDatePreset}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onPickDay={pickDay}
          onClearFilters={clearFilters}
          filterActive={filterActive}
          onNewNote={() => (narrow ? setComposing(true) : setSelectedId(null))}
          onCollapse={() => setManualListCollapsed(true)}
          inputRef={inputRef}
        />

        {/* Rows, grouped by date. Scroll container and padding copied
            from History.tsx:305. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" style={{ padding: "0 6px" }}>
          {isLoading && (
            <>
              <span className="sr-only" role="status">
                Loading notes
              </span>
              <SkeletonRows count={7} rowHeight={90} />
            </>
          )}
          {!isLoading && error && (
            <ListMessage text={error instanceof Error ? error.message : "Could not load notes"} />
          )}
          {!isLoading && !error && items.length === 0 && (
            <EmptyStateTier1
              icon={<StickyNote size={18} strokeWidth={1.5} />}
              ring="none"
              title="No notes yet"
              subtitle="Notes carry what you learned between reviews. They never decide anything."
            />
          )}
          {!isLoading && !error && items.length > 0 && shown.length === 0 && (
            <EmptyStateTier2
              title={
                query.trim().length > 0 ? (
                  <>
                    No notes match <SearchTerm q={query} />
                  </>
                ) : (
                  "No notes match your filters"
                )
              }
              resetLabel="Clear filters"
              onReset={clearEverything}
            />
          )}

          {buckets.map((bucket, bucketIndex) => (
            <section key={bucket.key}>
              {/* RulerTickHeader carries no horizontal padding of its
                  own, unlike History's inline bucket header, which adds
                  its own "0 6px" (History.tsx:325) on top of the scroll
                  container's "0 6px" (History.tsx:305). Without this
                  wrapper the label sat 6px closer to the edge than
                  History's does (fix round 1, Finding 3) — wrapping
                  rather than forking RulerTickHeader, per the brief's
                  reuse rule. */}
              <div style={{ padding: "0 6px" }}>
                <RulerTickHeader
                  label={bucket.label}
                  right={
                    <span className="font-mono tabular-nums" style={{ fontSize: 10, color: "var(--gw-t9)" }}>
                      {bucket.items.length}
                    </span>
                  }
                  marginClassName={bucketIndex === 0 ? "mt-[10px] mb-[8px]" : "mt-[16px] mb-[8px]"}
                />
              </div>

              {bucket.items.map((n) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  isSelected={n.id === selectedId}
                  onClick={() => setSelectedId(selectedId === n.id ? null : n.id)}
                  currentUserId={user?.id}
                />
              ))}
            </section>
          ))}
        </div>
      </div>
    );
  }

  // Phone layout: one pane at a time, driven by the same `?note=` selection
  // the desktop render below reads, plus the phone only `composing` flag.
  // No collapsed minimap here — that strip exists to free up room beside a
  // detail pane, and on a phone there is no detail pane sharing the screen
  // with it (History.tsx's own precedent).
  if (narrow) {
    if (composing) {
      return (
        <MobilePane title="New note" onBack={() => setComposing(false)}>
          <NoteRestingPane projectId={projectId} onCreated={selectCreatedNote} />
        </MobilePane>
      );
    }
    if (selected) {
      return (
        <MobilePane title={noteTitle(selected.body)} onBack={closeDetail}>
          <NoteDetail
            key={selected.id}
            note={selected}
            projectId={projectId}
            currentUserId={user?.id}
            onDeleted={() => setSelectedId(null)}
          />
        </MobilePane>
      );
    }
    // Not the resting composer: on a phone the list is the resting state,
    // and composing is reached through the explicit button above instead.
    return renderListColumn();
  }

  return (
    <div className="flex h-full min-w-0">
      {/* ── List column ── 392px expanded / 54px collapsed strip, matching
          History's list column exactly (History.tsx:206-213). */}
      <div
        className="h-full shrink-0 overflow-hidden transition-[width] duration-[180ms] ease-in-out"
        style={{ width: listCollapsed ? 54 : 392 }}
      >
        {listCollapsed ? (
          <NotesCollapsedStrip
            notes={shown}
            isLoading={isLoading}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(selectedId === id ? null : id)}
            onExpand={() => setManualListCollapsed(false)}
          />
        ) : (
          renderListColumn()
        )}
      </div>

      {/* ── Detail card ── History's detail surface, shadow included
          (History.tsx:372-377). */}
      <div
        className="m-[6px_6px_6px_0] min-w-0 flex-1 overflow-hidden rounded-[12px]"
        style={{
          background: "linear-gradient(180deg, var(--gw-panel-a), var(--gw-panel-b))",
          boxShadow: "0 12px 34px rgba(0,0,0,.4), inset 0 1px 0 rgba(var(--gw-line-rgb),.06)",
        }}
      >
        {selected ? (
          // Remounts on identity change, per Templates.tsx:209's precedent,
          // so NoteDetail's own edit state cannot leak from one note onto
          // whichever note is selected next.
          <NoteDetail
            key={selected.id}
            note={selected}
            projectId={projectId}
            currentUserId={user?.id}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <NoteRestingPane projectId={projectId} onCreated={selectCreatedNote} />
        )}
      </div>
    </div>
  );
}

function ListMessage({ text }: { text: string }) {
  return (
    <p className="px-[13px] py-6" style={{ margin: 0, fontSize: 12.5, color: "var(--gw-t8)" }}>
      {text}
    </p>
  );
}

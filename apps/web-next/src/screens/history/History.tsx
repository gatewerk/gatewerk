/**
 * History — the audit trail of resolved reviews. Two panes: a 406px list and a
 * read-only resolved record.
 *
 * Design: ListHistory.dc.html, DetailHistory.dc.html, DetailHistoryEmpty.dc.html.
 *
 * Built here: decision filter tabs, search, the filter popover (archived /
 * template / date range), the date grouping the redesign introduces (TODAY /
 * THIS WEEK / EARLIER under ruler ticks), decision-tinted rows, the read-only
 * record with inline diffs, and the 54px collapsed minimap (one dot per
 * visible record) with its header collapse button — zen mode now forces the
 * same collapse, per the shared `manualListCollapsed || zen` in Inbox and
 * Templates.
 *
 * Deliberately not built, and not half-built:
 *   - the typed diff matrix for image and json values
 * Export CSV/JSON and Archive/Unarchive are built — HistoryDetail.tsx's "..."
 * menu (HistoryDetailMenu.tsx), ported from apps/web's pages/history/
 * {DetailMenu,use-history-archive-actions,export-helpers}.tsx and simplified
 * to the single-record case (no bulk selection in this list yet). Delete is
 * deliberately absent — an audit trail hides a
 * decided review via Archive, it does not permanently destroy records.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { ZenOutletContext } from "~/shell/use-zen";
import { Clock } from "lucide-react";
import { reviews, type Review } from "@gatewerk/web-core/api/reviews";
import { getReviewTitle } from "@gatewerk/web-core/lib/utils";
import { buildHistoryList, decisionRole, matchesHistoryDate, type Filter } from "./history-model";
import { HistoryListHeader } from "./HistoryListHeader";
import { HistoryRow } from "./HistoryRow";
import { HistoryDetail } from "./HistoryDetail";
import { useHistoryKeys } from "./use-history-keys";
import { useSlashFocus } from "~/components/use-slash-focus";
import { EmptyStateTier1, EmptyStateTier2, EmptyStateTier3, SearchTerm } from "~/components/empty-state";
import { useNarrowViewport } from "~/shell/use-narrow-viewport";
import { SkeletonRows } from "~/components/skeleton";
import { MobilePane } from "../mobile/MobilePane";
import { usePaneSelection } from "../mobile/use-pane-selection";
import { historyDecidedQuery, historyExpiredQuery, HISTORY_PAGE_SIZE } from "~/route-queries";

/**
 * History selection moved from useState into `?entry=`.
 *
 * Two reasons, and the phone one is the load bearing one. On a phone the
 * detail takes the whole screen, so the back gesture has to return to the
 * list. Local state cannot do that: back would leave the app. Second, it
 * matches Inbox, which has held selection in the URL since it was written.
 */
export function selectedIdFromParams(params: URLSearchParams): string | null {
  return params.get("entry") || null;
}

/** The template a row belongs to, by slug, falling back to the embed's name. */
function templateSlugOf(r: Review): string {
  return r.template_slug ?? r.template?.name ?? "";
}

export function History() {
  useEffect(() => {
    document.title = "History · Gatewerk";
  }, []);

  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const narrow = useNarrowViewport();
  // Selection lives in the URL (?entry=<id>) so refresh, back, and shared links
  // restore it — see selectedIdFromParams above. usePaneSelection owns the one
  // thing that differs by width: on a phone the detail is the whole screen, so
  // opening one has to push a history entry or the back gesture skips the list
  // and leaves the screen entirely.
  const { selectedId, select: setSelectedId, close: closeDetail } = usePaneSelection(
    "entry",
    narrow,
  );
  const [filterOpen, setFilterOpen] = useState(false);
  const { zen } = useOutletContext<ZenOutletContext>();
  // Zen forces the list shut without discarding the reviewer's own choice —
  // it reappears at whatever manual state it was in once zen ends.
  const [manualListCollapsed, setManualListCollapsed] = useState(false);
  const listCollapsed = manualListCollapsed || zen;
  const [showArchived, setShowArchived] = useState(false);
  const [templateFilter, setTemplateFilter] = useState<string[]>([]);
  const [datePreset, setDatePreset] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Three queries rather than one. The list API takes a single status, and
  // History is the record of everything that came to rest: decided reviews and
  // the ones that lapsed. Archived is a third fetch rather than a flag, and is
  // only issued when the toggle asks for it.
  const decided = useQuery(historyDecidedQuery);
  const expired = useQuery(historyExpiredQuery);
  const archived = useQuery({
    queryKey: ["reviews", "history", "archived"],
    queryFn: () => reviews.list({ status: "archived", limit: HISTORY_PAGE_SIZE }),
    enabled: showArchived,
  });

  const items: Review[] = useMemo(
    () => [
      ...(decided.data?.items ?? []),
      ...(expired.data?.items ?? []),
      ...(showArchived ? (archived.data?.items ?? []) : []),
    ],
    [decided.data, expired.data, archived.data, showArchived],
  );

  // Gated on the two always-on queries only. Ticking "Show archived" enables a
  // third fetch, and folding its first load in here replaced a list that was
  // already in cache with the word "Loading" — the screen blanked in response
  // to a filter that is meant to ADD rows. The archived rows appear when they
  // arrive.
  const isLoading = decided.isPending || expired.isPending;
  const error = decided.error ?? expired.error ?? (showArchived ? archived.error : null);

  const templateOptions = useMemo(
    () => [...new Set(items.map(templateSlugOf).filter(Boolean))],
    [items],
  );

  // A template that appears only on archived rows loses its checkbox the
  // moment "Show archived" goes off, but it stayed in templateFilter — the
  // list emptied and the only explanation on screen was the green dot on a
  // popover with no such row in it. Pruning the state (rather than filtering
  // at read time) also keeps `filterActive` honest about what is applied.
  //
  // Guarded on items: an empty option set while the first fetch is in flight
  // means "not loaded yet", not "that template is gone".
  useEffect(() => {
    if (items.length === 0) return;
    setTemplateFilter((prev) => {
      const kept = prev.filter((name) => templateOptions.includes(name));
      // Same array back when nothing was dropped, or this setState loops.
      return kept.length === prev.length ? prev : kept;
    });
  }, [items, templateOptions]);

  // `now` is captured once per recompute rather than read inside the bucketing
  // and inside each row, so the date filter, the section a row lands in, and
  // the age it prints are all measured against the same instant. Bucketing and
  // filtering disagreeing about "today" is the classic off-by-one here.
  const { buckets, now } = useMemo(() => {
    const now = new Date();
    const scoped = items
      .filter((r) => templateFilter.length === 0 || templateFilter.includes(templateSlugOf(r)))
      .filter((r) => matchesHistoryDate(r, datePreset, dateFrom, dateTo, now));
    return {
      now,
      buckets: buildHistoryList(scoped, {
        filter,
        query,
        now,
        titleOf: (r) => getReviewTitle(r.payload ?? {}, r.id),
      }),
    };
  }, [items, filter, query, templateFilter, datePreset, dateFrom, dateTo]);

  const visible = useMemo(() => buckets.flatMap((b) => b.items), [buckets]);
  const selected = visible.find((r) => r.id === selectedId) ?? null;

  // Memoised because it is a dependency of the keydown effect: a fresh array
  // every render tore the listener down and re-added it on every commit.
  const visibleIds = useMemo(() => visible.map((r) => r.id), [visible]);

  useHistoryKeys({
    visibleIds,
    selectedId,
    filterOpen,
    setSelectedId,
    setFilterOpen,
  });
  useSlashFocus(searchRef);

  const filterActive =
    showArchived || templateFilter.length > 0 || !!datePreset || !!dateFrom || !!dateTo;

  function toggleTemplate(name: string) {
    setTemplateFilter((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  }

  function pickDay(iso: string) {
    if (!dateFrom || (dateFrom && dateTo)) {
      setDateFrom(iso); setDateTo(""); setDatePreset(null);
    } else if (iso < dateFrom) {
      setDateTo(dateFrom); setDateFrom(iso); setDatePreset(null);
    } else {
      setDateTo(iso); setDatePreset(null);
    }
  }

  function applyDatePreset(key: string | null) {
    setDatePreset(key);
    setDateFrom("");
    setDateTo("");
  }

  function clearFilters() {
    setShowArchived(false);
    setTemplateFilter([]);
    setDatePreset(null);
    setDateFrom("");
    setDateTo("");
  }

  // Backs the empty state's "Clear all filters". The narrower resets (clear the
  // search box, show all decisions) are wired individually at the call site so
  // each cause offers to undo only the thing that caused it.
  function clearEverything() {
    setQuery("");
    setFilter("all");
    clearFilters();
  }

  // Header + rows, factored out of the desktop expanded column so a phone can
  // reuse it full width without duplicating the list body (loading/error/
  // empty/buckets). A closure over the component's own state rather than a
  // separate component: it does not need its own identity, only to avoid
  // saying the same JSX twice.
  function renderListColumn() {
    return (
      <div className="flex h-full min-w-0 flex-col">
        <HistoryListHeader
          filter={filter}
          onFilter={setFilter}
          query={query}
          onQuery={setQuery}
          searchRef={searchRef}
          filterOpen={filterOpen}
          onFilterOpenChange={setFilterOpen}
          showArchived={showArchived}
          onShowArchived={setShowArchived}
          templateFilter={templateFilter}
          onToggleTemplate={toggleTemplate}
          templateOptions={templateOptions}
          datePreset={datePreset}
          onDatePreset={applyDatePreset}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onPickDay={pickDay}
          onClearFilters={clearFilters}
          filterActive={filterActive}
          onCollapse={() => setManualListCollapsed(true)}
        />

        {/* Rows, grouped by date */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" style={{ padding: "0 6px" }}>
          {isLoading && (
            <>
              <span className="sr-only" role="status">
                Loading history
              </span>
              <SkeletonRows count={9} rowHeight={69} />
            </>
          )}
          {!isLoading && error && (
            <ListMessage text={error instanceof Error ? error.message : "Could not load history"} />
          )}
          {!isLoading && !error && visible.length === 0 && (
            <EmptyState
              query={query}
              filter={filter}
              filterActive={filterActive}
              onClearSearch={() => setQuery("")}
              onShowAll={() => setFilter("all")}
              onClearFilters={clearEverything}
            />
          )}

          {buckets.map((bucket, bucketIndex) => (
            <section key={bucket.key}>
              <div
                className="flex items-center"
                style={{ gap: 10, padding: bucketIndex === 0 ? "10px 6px 8px" : "16px 6px 8px" }}
              >
                <span
                  className="shrink-0 font-mono font-semibold uppercase"
                  style={{ fontSize: 10, color: "var(--gw-t8)", letterSpacing: ".16em" }}
                >
                  {bucket.label}
                </span>
                <div
                  className="min-w-0 flex-1"
                  style={{ height: 1, background: "rgba(var(--gw-line-rgb),.07)" }}
                />
                <span
                  className="shrink-0 font-mono tabular-nums"
                  style={{ fontSize: 10, color: "var(--gw-t9)" }}
                >
                  {bucket.items.length}
                </span>
                {/* End tick. A ruler ends in a mark, not in thin air. History
                    carries it on list and main column headers; the right rail
                    deliberately does not. */}
                <span
                  aria-hidden
                  className="shrink-0"
                  style={{ width: 1, height: 6, background: "rgba(var(--gw-line-rgb),.13)" }}
                />
              </div>

              {bucket.items.map((r) => (
                <HistoryRow
                  key={r.id}
                  review={r}
                  isSelected={r.id === selectedId}
                  onClick={() => setSelectedId(r.id)}
                  now={now}
                />
              ))}
            </section>
          ))}
        </div>
      </div>
    );
  }

  // Phone layout: one pane at a time, driven by the same `?entry=` selection
  // the desktop render below reads. No collapsed minimap here — that strip
  // exists to free up room beside a detail pane, and on a phone there is no
  // detail pane sharing the screen with it.
  if (narrow) {
    if (selected) {
      return (
        <MobilePane
          title={getReviewTitle(selected.payload ?? {}, selected.id)}
          onBack={closeDetail}
        >
          <HistoryDetail review={selected} />
        </MobilePane>
      );
    }
    return renderListColumn();
  }

  return (
    <div className="flex h-full min-w-0">
      {/* ── List column ── 392px expanded / 54px collapsed strip, matching the
          Inbox's list column exactly (History's
          chrome follows the Inbox, which overrides the prototype's own
          measurements). */}
      <div
        className="h-full shrink-0 overflow-hidden transition-[width] duration-[180ms] ease-in-out"
        style={{ width: listCollapsed ? 54 : 392 }}
      >
        {listCollapsed ? (
          /* Collapsed strip: one dot per visible record, same filtered set as
             the expanded list. Colored only for exceptions, like the rows:
             destructive red, lapsed/retried blue, the approved majority
             neutral — a wall of green dots would be the bar problem again. */
          <div className="flex h-full flex-col items-center gap-1 py-[14px]">
            <button
              type="button"
              onClick={() => setManualListCollapsed(false)}
              title="Expand list"
              className="mb-1.5 flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-[9px] border-none bg-transparent text-t8 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)] hover:text-t4"
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
                <line x1="9.5" y1="4" x2="9.5" y2="20" strokeDasharray="2 2" />
              </svg>
            </button>

            {!isLoading &&
              visible.slice(0, 24).map((r) => {
                const role = decisionRole(r.decision);
                const selected = selectedId === r.id;
                const bg =
                  role === "destructive"
                    ? "var(--gw-red-bar)"
                    : role === "neutral"
                      ? "var(--gw-blue-bar)"
                      : selected
                        ? "var(--gw-t3)"
                        : "rgba(var(--gw-line-rgb),.28)";
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    title={getReviewTitle(r.payload ?? {}, r.id)}
                    className="flex w-[38px] shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-none transition-colors"
                    style={{
                      height: selected ? 30 : 28,
                      background: selected ? "rgba(var(--gw-line-rgb),.08)" : "transparent",
                      boxShadow: selected
                        ? "inset 0 0 0 1px rgba(var(--gw-line-rgb),.09)"
                        : "none",
                    }}
                  >
                    <span
                      style={{
                        display: "block",
                        width: selected ? 8 : 7,
                        height: selected ? 8 : 7,
                        borderRadius: "50%",
                        background: bg,
                      }}
                    />
                  </button>
                );
              })}
          </div>
        ) : (
          renderListColumn()
        )}
      </div>

      {/* ── Detail card ── the Inbox detail pane's exact surface, shadow
          included: without the drop shadow the card has no depth and reads as
          a flat fill next to the list instead of a floating panel. */}
      <div
        className="m-[6px_6px_6px_0] min-w-0 flex-1 overflow-hidden rounded-[12px]"
        style={{
          background: "linear-gradient(180deg, var(--gw-panel-a), var(--gw-panel-b))",
          boxShadow: "0 12px 34px rgba(0,0,0,.4), inset 0 1px 0 rgba(var(--gw-line-rgb),.06)",
        }}
      >
        {/* One empty state per screen, not two (Empty States board, spec
            §acceptance 8): with an empty list its own Tier 1 or Tier 2 state
            already carries the message, so the detail pane stays blank. */}
        {selected ? (
          <HistoryDetail review={selected} />
        ) : visible.length > 0 ? (
          <DetailEmpty />
        ) : null}
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

const TAB_EMPTY_TITLES: Record<Exclude<Filter, "all">, string> = {
  approved: "No approved reviews yet",
  rejected: "No rejected reviews yet",
  retried: "No retried reviews yet",
};

/**
 * Three causes, three ways back — the same rule the inbox follows. Collapsing
 * them into one "No history matches" would print an empty search term when the
 * reviewer had only switched tabs, and would offer to clear a search they never
 * typed.
 */
function EmptyState({
  query,
  filter,
  filterActive,
  onClearSearch,
  onShowAll,
  onClearFilters,
}: {
  query: string;
  filter: Filter;
  filterActive: boolean;
  onClearSearch: () => void;
  onShowAll: () => void;
  onClearFilters: () => void;
}) {
  if (query.trim().length > 0) {
    return (
      <EmptyStateTier2
        title={
          <>
            No history matches <SearchTerm q={query} />
          </>
        }
        resetLabel="Clear search"
        onReset={onClearSearch}
      />
    );
  }

  if (filterActive) {
    return (
      <EmptyStateTier2
        title="No history matches your filters"
        resetLabel="Clear all filters"
        onReset={onClearFilters}
      />
    );
  }

  if (filter !== "all") {
    return (
      <EmptyStateTier2
        title={TAB_EMPTY_TITLES[filter]}
        resetLabel="Show all history"
        onReset={onShowAll}
      />
    );
  }

  // ring="none" and variant="quiet" are deliberate: History waits on a
  // person, not a machine, so a live pulsing ring would claim something is
  // being received when nothing is.
  return (
    <EmptyStateTier1
      icon={<Clock size={18} strokeWidth={1.5} />}
      ring="none"
      title="No reviews have closed yet"
      subtitle="Once you approve, reject, or retry a review, the full record lands here."
      footer={{ kind: "status", variant: "quiet", label: "Waiting for first decision" }}
    />
  );
}

/**
 * Nothing selected. The keycap row is not decoration — it is the only place
 * arrow-key browsing is advertised, and the design puts it here for that
 * reason.
 */
function DetailEmpty() {
  return (
    <EmptyStateTier3
      icon={<Clock size={24} strokeWidth={1.6} />}
      title="Select a record to view its decision"
      body="Pick any decided review from the list to see who decided, when, and the feedback they gave."
    >
      <div
        className="flex items-center font-mono"
        style={{ gap: 7, marginTop: 2, fontSize: 11, color: "var(--gw-t9)" }}
      >
        <span style={KEYCAP}>↑</span>
        <span style={KEYCAP}>↓</span>
        <span style={{ marginLeft: 2 }}>to browse</span>
      </div>
    </EmptyStateTier3>
  );
}

const KEYCAP: React.CSSProperties = {
  border: "1px solid rgba(var(--gw-line-rgb),.12)",
  borderRadius: 5,
  padding: "2px 6px",
};

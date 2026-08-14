/**
 * Templates list column — the Inbox list shell with a templates payload.
 *
 * Header row A: segmented tab pill (All / Active / Inactive / Drafts), the
 * green New button, the collapse button. Row B: search.
 *
 * Two affordances the prototype draws are deliberately absent:
 *   * the filter funnel — on Templates the prototype forces its template list
 *     empty and `tplVisible()` reads none of the date state, so it is a control
 *     that can only ever lie (manifest §8.9). Templates already filter by tab
 *     and search.
 *   * multi-select and the bulk bar — the prototype's only entry point is a key
 *     handler scoped to the inbox, so bulk delete is unreachable there
 *     (manifest §10.2 #1), and neither handler mutates anything.
 * Both are held, not lost: they are named in the S3 report.
 */
import { useRef } from "react";
// The Empty States board and the spec's icon table gave Templates the Copy
// glyph on every tier; the nav (IconRail.tsx / NavDrawer.tsx) had drifted to
// LayoutTemplate instead, so the app showed two different templates icons.
// SquareStack ends the split — one templates
// icon everywhere, here included.
import { Loader2, Plus, SquareStack } from "lucide-react";
import { SegmentedTabs } from "~/components/SegmentedTabs";
import { ListSearchField } from "~/components/ListSearchField";
import { useSlashFocus } from "~/components/use-slash-focus";
import { EmptyStateTier1, EmptyStateTier2, SearchTerm } from "~/components/empty-state";
import { SkeletonRows } from "~/components/skeleton";
import { IconButton } from "./_ui";
import { TemplateRow } from "./TemplateRow";
import {
  TEMPLATE_TABS,
  TEMPLATE_TAB_LABELS,
  templateTabEmptyCopy,
  visibleTemplates,
  type TemplateListItem,
  type TemplateTab,
} from "./template-filters";

interface Props {
  items: TemplateListItem[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  tab: TemplateTab;
  onTab: (tab: TemplateTab) => void;
  query: string;
  onQuery: (q: string) => void;
  onCollapse: () => void;
  onCreate: () => void;
  creating: boolean;
}

export function TemplateList({
  items,
  isLoading,
  error,
  onRetry,
  selectedId,
  onSelect,
  tab,
  onTab,
  query,
  onQuery,
  onCollapse,
  onCreate,
  creating,
}: Props) {
  const visible = visibleTemplates(items, tab, query);
  const showEmpty = !isLoading && !error && visible.length === 0;
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  const isFirstRun = showEmpty && items.length === 0 && !query.trim();
  const isSearchMiss = showEmpty && !isFirstRun && query.trim().length > 0;
  const isTabMiss = showEmpty && !isFirstRun && !isSearchMiss;

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ── */}
      <div className="flex flex-col gap-[11px] px-3 pt-[15px] pb-[11px]">
        <div className="flex items-center gap-2">
          <SegmentedTabs
            tabs={TEMPLATE_TABS.map((value) => ({ value, label: TEMPLATE_TAB_LABELS[value] }))}
            active={tab}
            onChange={onTab}
            ariaLabel="Filter by status"
          />

          {/* New template — the one solid-green affordance in the list column */}
          <button
            type="button"
            title="New template"
            aria-label="New template"
            disabled={creating}
            aria-busy={creating}
            onClick={onCreate}
            className="gw-focus-ring flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-none transition-all active:scale-[0.93] disabled:cursor-not-allowed disabled:opacity-70"
            style={{ background: "var(--gw-green)", color: "var(--gw-green-ink)" }}
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} strokeWidth={2.5} />}
          </button>

          <IconButton title="Collapse list" onClick={onCollapse}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <rect x="3" y="4" width="6.5" height="16" rx="2" fill="currentColor" stroke="none" />
            </svg>
          </IconButton>
        </div>

        {/* Search — the shared field carries the Escape clear-then-blur
            behavior this input pioneered. */}
        <ListSearchField
          value={query}
          onChange={onQuery}
          placeholder="Search templates…"
          ariaLabel="Search templates"
          inputRef={searchRef}
        />
      </div>

      {/* ── Rows ── */}
      <div className="flex flex-1 flex-col gap-[2px] overflow-y-auto px-1.5 pb-3">
        {isLoading && (
          <>
            <span className="sr-only" role="status">
              Loading templates
            </span>
            <SkeletonRows count={8} rowHeight={69} />
          </>
        )}

        {!isLoading && error != null && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-[34px] py-10 text-center">
            <div className="text-[12.5px] font-medium text-t4">
              {error instanceof Error ? error.message : "Templates could not be loaded"}
            </div>
            <button
              type="button"
              onClick={onRetry}
              className="cursor-pointer border-none bg-transparent text-[11.5px] font-medium text-green-t transition-opacity hover:opacity-75"
            >
              Try again
            </button>
          </div>
        )}

        {!isLoading &&
          error == null &&
          visible.map((t) => (
            <TemplateRow key={t.id} template={t} isSelected={selectedId === t.id} onClick={() => onSelect(t.id)} />
          ))}

        {isFirstRun && (
          <EmptyStateTier1
            icon={<SquareStack size={18} strokeWidth={1.5} />}
            ring="none"
            title="No templates yet"
            subtitle="Templates define the fields, tone, and priorities of each review."
            footer={{ kind: "action", label: "New template", onClick: onCreate, busy: creating }}
          />
        )}

        {isSearchMiss && (
          <EmptyStateTier2
            title={
              <>
                No templates match <SearchTerm q={query} />
              </>
            }
            resetLabel="Clear search"
            onReset={() => onQuery("")}
          />
        )}

        {/* `tab !== "all"` is a type narrowing, not a condition that can flip:
            with no query the all tab shows every row, so it is empty only when
            the whole list is, and that is isFirstRun above. */}
        {isTabMiss && tab !== "all" && (
          <EmptyStateTier2
            {...templateTabEmptyCopy(tab, items)}
            resetLabel="Show all"
            onReset={() => onTab("all")}
          />
        )}
      </div>
    </div>
  );
}

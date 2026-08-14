/**
 * ActivityPane — read-only audit log for this project's admins.
 *
 * Loads from GET /api/v1/audit (packages/web-core/src/api/audit.ts) with
 * optional action / resource_type filters. Pagination is manual "Load more"
 * against `has_more`, matching apps/web's
 * pages/settings/project/activity/ActivityPane.tsx (the behavior reference
 * this was ported from — copy and pagination model carried over verbatim).
 *
 * Markup follows the Redesign prototype's grammar (manifest §2.6, S6.0-S6.2):
 * a filter row of plain inset inputs, then FLAT audit rows (no card shell) —
 * action chip + resource on the first line, actor below, relative time and a
 * "Show"/"Hide" disclosure right-aligned. The prototype draws an Actor filter
 * too, but audit.ts's ListAuditParams has no `actor` field — the endpoint
 * this pane calls does not support it, so no such hint would be true, and
 * the field stays dropped (see the S6.1 note in the manifest table and the
 * original gap note this replaces).
 *
 * Gap vs the reference's error state: audit.ts's `list()` never throws — a
 * 401/403 or network failure resolves to an empty page instead (deliberate,
 * per its own doc comment: the audit scope is admin-only and a non-admin
 * must not get a session-killing cascade). The "Failed to load activity"
 * branch below is kept for defensiveness but is not reachable today; a
 * non-admin viewing this pane sees "No activity yet", not an error.
 *
 * Design: theme tokens only, records stay neutral ink (no color grading of
 * audit rows — an audit row is a fact, not something needing attention).
 * Empty details render as silence (no control, no row), not as a "None"
 * caveat.
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Loader2 } from "lucide-react";
import { AUDIT_ACTIONS } from "@gatewerk/shared";
import { audit, type AuditEvent } from "@gatewerk/web-core/api/audit";
import { timeAgoShort } from "@gatewerk/web-core/lib/utils";
import { EmptyState, GhostButton, INSET_STYLE } from "../../templates/_ui";
import { SegmentedTabs } from "~/components/SegmentedTabs";
import {
  ActionLink,
  FILTER_CONTROL_CLASS,
  FilterField,
  MultiSelectFilterMenu,
  PaneHeader,
  type MultiSelectOption,
} from "../_shared/ui";
import { DateRangePopover } from "../_shared/DateRangePopover";
import { DeliveriesPane } from "../deliveries/DeliveriesPane";

type LogTab = "activity" | "deliveries";

const LOG_TABS = [
  { value: "activity", label: "Activity" },
  { value: "deliveries", label: "Deliveries" },
] as const;

// MultiSelectFilterMenu wants {value,label} pairs; AUDIT_ACTIONS is a flat
// list of literal action strings that already read fine as their own label.
const ACTION_OPTIONS: MultiSelectOption[] = AUDIT_ACTIONS.map((a) => ({ value: a, label: a }));
import {
  ACTIVITY_PAGE_SIZE,
  EMPTY_ACTIVITY_FILTERS,
  activityEventMeta,
  appendActivityPage,
  buildAuditParams,
  hasActiveActivityFilters,
  type ActivityFilters,
} from "./activity-logic";

/**
 * One audit event, flat (manifest S6.2 — no card shell). Action chip +
 * resource share the first line; the actor sits below, plain mono (not
 * ActorRow: that component draws an avatar for emails and pushes a `role`
 * label to the far right of ITS OWN row, both of which fight the single
 * right-aligned time/disclosure column this compact grammar wants — the
 * action already reads from the chip, so ActorRow's role slot has nothing
 * left to carry here).
 */
function ActivityRow({ event }: { event: AuditEvent }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = !!event.details && Object.keys(event.details).length > 0;
  const resource = activityEventMeta(event).join(" ");

  const rowContent = (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="shrink-0 rounded-[5px] px-[7px] py-[2px] font-mono text-[11px]"
            style={{ background: "rgba(var(--gw-line-rgb),.05)", color: "var(--gw-t5)" }}
          >
            {event.action}
          </span>
          <span className="truncate font-mono text-[11.5px]" style={{ color: "var(--gw-t7)" }}>
            {resource}
          </span>
        </div>
        <span className="truncate font-mono text-[11.5px]" style={{ color: "var(--gw-t8)" }}>
          {event.actor}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <span className="font-mono text-[11px]" style={{ color: "var(--gw-t8)" }}>
          {timeAgoShort(event.created_at)}
        </span>
        {hasDetails && (
          // Plain span, not a nested button — the whole row is the click
          // target now (below), and a button can't contain another button.
          <span
            className="flex items-center gap-0.5 font-mono text-[11px]"
            style={{ color: "var(--gw-t8)" }}
          >
            {expanded ? "Hide" : "Show"}
            <ChevronRight
              size={11}
              className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
            />
          </span>
        )}
      </div>
    </>
  );

  return (
    <div className="flex flex-col">
      {hasDetails ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="gw-focus-ring flex w-full cursor-pointer items-center gap-3 rounded-[9px] border-none bg-transparent px-2 py-2.5 text-left transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.02)]"
        >
          {rowContent}
        </button>
      ) : (
        <div className="flex items-center gap-3 rounded-[9px] px-2 py-2.5">{rowContent}</div>
      )}

      {expanded && hasDetails && (
        <pre
          className="mx-2 mb-1.5 max-h-48 overflow-auto rounded-[8px] px-2.5 py-2 font-mono text-[10.5px] whitespace-pre-wrap break-all"
          style={{ ...INSET_STYLE, color: "var(--gw-t6)" }}
        >
          {JSON.stringify(event.details, null, 2)}
        </pre>
      )}
    </div>
  );
}

// Typing settles into a query after this many idle ms — long enough that a
// normal typing cadence never fires mid-word, short enough to still read as
// "instant." Action and date range skip this entirely (updateFilters applies
// them the moment they change): both are discrete, settled-value pickers —
// a checkbox click or a calendar day is already the final value, the way
// DeliveriesPane's status tabs and date range are. Free text is the one
// control here that changes on every keystroke, so it's the one exception.
const RESOURCE_TYPE_DEBOUNCE_MS = 350;

export function ActivityPane() {
  const [filters, setFilters] = useState<ActivityFilters>(EMPTY_ACTIVITY_FILTERS);
  const [resourceTypeDraft, setResourceTypeDraft] = useState("");
  const resourceTypeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    return () => {
      if (resourceTypeTimer.current) clearTimeout(resourceTypeTimer.current);
    };
  }, []);

  const { isLoading, error, isFetching } = useQuery({
    queryKey: ["settings", "activity", filters, offset],
    queryFn: async () => {
      const res = await audit.list(buildAuditParams(filters, offset));
      setItems((prev) => appendActivityPage(prev, res.items, offset));
      setHasMore(res.has_more);
      return res;
    },
  });

  // Instant-apply, matching DeliveriesPane — no Apply step, Clear takes its
  // place in the filter bar.
  function updateFilters(patch: Partial<ActivityFilters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setOffset(0);
    setItems([]);
  }

  function handleResourceTypeChange(value: string) {
    setResourceTypeDraft(value);
    if (resourceTypeTimer.current) clearTimeout(resourceTypeTimer.current);
    resourceTypeTimer.current = setTimeout(() => updateFilters({ resourceType: value }), RESOURCE_TYPE_DEBOUNCE_MS);
  }

  function commitResourceType() {
    if (resourceTypeTimer.current) clearTimeout(resourceTypeTimer.current);
    updateFilters({ resourceType: resourceTypeDraft });
  }

  function clearFilters() {
    if (resourceTypeTimer.current) clearTimeout(resourceTypeTimer.current);
    setResourceTypeDraft("");
    setFilters(EMPTY_ACTIVITY_FILTERS);
    setOffset(0);
    setItems([]);
  }

  // Draft-aware: while the resource-type debounce is still pending, `filters`
  // itself hasn't caught up yet, so checking it alone would hide Clear for
  // the ~350ms after typing starts.
  const filtersActive = hasActiveActivityFilters({ ...filters, resourceType: resourceTypeDraft });

  const [searchParams, setSearchParams] = useSearchParams();
  const tab: LogTab = searchParams.get("tab") === "deliveries" ? "deliveries" : "activity";

  function setTab(next: LogTab) {
    const params = new URLSearchParams(searchParams);
    if (next === "activity") params.delete("tab");
    else params.set("tab", next);
    setSearchParams(params, { replace: true });
  }

  return (
    <div className="flex w-full flex-col gap-[26px]">
      <PaneHeader
        title="Activity"
        subtitle={
          tab === "activity"
            ? "Audit log of everything that happened"
            : "Webhook delivery attempts and failures"
        }
      />

      {/* Two logs, one page (merged IA). Tabs, not
          columns — log rows carry long URLs and error strings that half-width
          columns would truncate hard. Tab state lives in the URL so
          /settings/activity?tab=deliveries deep-links and the legacy
          /settings/deliveries redirect can land here. */}
      <div className="max-w-[420px]">
        <SegmentedTabs tabs={LOG_TABS} active={tab} onChange={setTab} ariaLabel="Log" equalWidth />
      </div>

      {tab === "deliveries" && <DeliveriesPane />}

      {tab === "activity" && (
      <div className="flex flex-wrap items-end gap-2.5">
        <FilterField label="Action">
          <MultiSelectFilterMenu
            value={filters.action}
            onChange={(next) => updateFilters({ action: next })}
            options={ACTION_OPTIONS}
            allLabel="All actions"
            pluralNoun="actions"
            ariaLabel="Filter by action"
            searchPlaceholder="Search actions…"
            mono
          />
        </FilterField>
        <FilterField label="Resource type">
          <input
            aria-label="Filter by resource type"
            value={resourceTypeDraft}
            onChange={(e) => handleResourceTypeChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitResourceType();
            }}
            onBlur={commitResourceType}
            placeholder="review"
            className={FILTER_CONTROL_CLASS}
          />
        </FilterField>
        <FilterField label="Date range">
          <DateRangePopover
            dateFrom={filters.dateFrom}
            dateTo={filters.dateTo}
            onChange={(dateFrom, dateTo) => updateFilters({ dateFrom, dateTo })}
          />
        </FilterField>
        {filtersActive && (
          <div className="flex h-[35px] shrink-0 items-center">
            <ActionLink onClick={clearFilters}>Clear</ActionLink>
          </div>
        )}
      </div>
      )}

      {tab === "activity" &&
        (error ? (
          <EmptyState
            title="Failed to load activity"
            hint={error instanceof Error ? error.message : undefined}
          />
        ) : isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 size={16} className="animate-spin" style={{ color: "var(--gw-t8)" }} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState title="No activity yet" />
        ) : (
          <div className="flex flex-col">
            {items.map((event) => (
              <ActivityRow key={event.id} event={event} />
            ))}
          </div>
        ))}

      {tab === "activity" && hasMore && !isLoading && items.length > 0 && (
        <div className="flex justify-center">
          <GhostButton onClick={() => setOffset((o) => o + ACTIVITY_PAGE_SIZE)} disabled={isFetching}>
            {isFetching ? "Loading" : "Load more"}
          </GhostButton>
        </div>
      )}
    </div>
  );
}

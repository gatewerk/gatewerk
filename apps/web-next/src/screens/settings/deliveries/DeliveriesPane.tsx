/**
 * DeliveriesPane — read-only webhook delivery log for project admins.
 *
 * Loads from GET /api/v1/webhooks/deliveries (packages/web-core/src/api/
 * deliveries.ts's `listDeliveries`), offset-paginated with a manual "Load
 * more" against `has_more` — same pagination model as ActivityPane and the
 * behavior reference this was ported from, apps/web's
 * pages/settings/project/deliveries/DeliveriesPane.tsx.
 *
 * Restyled to the Redesign prototype's Settings grammar (manifest §2.7):
 * flat hairline rows via the `_shared/ui` kit rather than the card list this
 * used to render. The prototype's rows are grey "View" + blue "Retry" links;
 * "View" is dropped — it is a stub in the prototype (`onView` just flashes a
 * toast) and every field its modal would have shown (event, url, status,
 * attempts, last attempt, error) is already on the row, so the link would
 * promise a drilldown that doesn't exist.
 *
 * Status color IS live attention here: failed = red badge, pending = amber
 * badge, delivered = no badge (defaults render as silence). Retry is offered
 * only for failed deliveries — see deliveries-logic.ts's file doc for why
 * that narrows the reference's `status !== "delivered"` gate. The
 * prototype's error line hex (`#b47a72`) is not carried over — theme tokens
 * only, so it becomes `var(--gw-red-t)`.
 *
 * Three fixes bring this in line with its
 * ActivityPane sibling —
 *   1. A status filter (SegmentedTabs, instant-apply — only 4 values, so
 *      Activity's search-box-and-Apply machinery would be overkill). The
 *      endpoint already took `status`; only the client wrapper didn't
 *      expose it.
 *   2. The url line had `truncate` but no `min-w-0`, so as a flex child
 *      next to unbreakable text it never actually clipped — every row
 *      printed its full webhook URL, often repeated across many
 *      consecutive rows for the same endpoint. Now it truncates, keeps the
 *      full value in a native title tooltip, and copies on click (the
 *      click-to-copy language this settings section already uses
 *      elsewhere, e.g. ProjectPane's Project ID row).
 *   3. Time moves into its own right-aligned column, matching
 *      ActivityRow's chip-line-left / time-column-right layout instead of
 *      running it into the same line as the event chip and attempt count.
 *
 * Two later, smaller passes:
 * - Clear only shows for event type / date range, not a non-"all" status —
 *   the status SegmentedTabs is itself a one-click reset (see
 *   deliveries-logic.ts's hasActiveDismissableDeliveryFilters doc).
 * - Event type filter (MultiSelectFilterMenu, promoted to _shared/ui.tsx
 *   from ActivityPane's own Action filter when this needed the same shape).
 *   Its vocabulary is NOT webhooks-logic.ts's AVAILABLE_EVENTS — that's the
 *   newer named-webhook (notification_channels) system, a different
 *   dispatch path from this legacy per-project delivery log; see
 *   DELIVERY_EVENT_TYPES's doc comment in deliveries-logic.ts.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { listDeliveries, retryDelivery, type WebhookDelivery } from "@gatewerk/web-core/api/deliveries";
import { timeAgoShort } from "@gatewerk/web-core/lib/utils";
import { AddLink, EmptyState } from "../../templates/_ui";
import { ActionLink, FilterField, MultiSelectFilterMenu } from "../_shared/ui";
import { DateRangePopover } from "../_shared/DateRangePopover";
import { SegmentedTabs } from "~/components/SegmentedTabs";
import { StatusBadge } from "~/components/StatusBadge";
import {
  DELIVERIES_PAGE_SIZE,
  DELIVERY_EVENT_TYPES,
  EMPTY_DELIVERY_FILTERS,
  appendDeliveriesPage,
  buildDeliveryParams,
  canRetryDelivery,
  deliveryMeta,
  deliveryStatusTone,
  deliveryTimestamp,
  hasActiveDeliveryFilters,
  hasActiveDismissableDeliveryFilters,
  isDeliveryErrorLong,
  truncateDeliveryError,
  type DeliveryFilters,
  type DeliveryStatusFilter,
} from "./deliveries-logic";

const STATUS_TABS: { value: DeliveryStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "failed", label: "Failed" },
  { value: "pending", label: "Pending" },
  { value: "delivered", label: "Delivered" },
];

/** Error text, flat when short; behind a Show/Hide disclosure when long. */
function ErrorLine({ error }: { error: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!error) return null;

  if (!isDeliveryErrorLong(error)) {
    return (
      <span className="font-mono text-[11.5px]" style={{ color: "var(--gw-red-t)" }}>
        {error}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      className="flex w-full cursor-pointer items-start gap-1 border-none bg-transparent p-0 text-left font-mono text-[11.5px] transition-colors hover:opacity-75"
      style={{ color: "var(--gw-red-t)" }}
    >
      <span className="mt-0.5 shrink-0">{expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
      <span className={expanded ? "whitespace-pre-wrap break-all" : "truncate"}>
        {expanded ? error : truncateDeliveryError(error)}
      </span>
    </button>
  );
}

/** Webhook URL, truncated with the full value on hover and click-to-copy —
 *  the same value-is-the-affordance language as ProjectPane's Project ID
 *  row, not a separate button beside the text. */
function DeliveryUrl({ url }: { url: string }) {
  function copy() {
    navigator.clipboard.writeText(url).then(
      () => toast.success("Webhook URL copied"),
      () => toast.error("Failed to copy"),
    );
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={url}
      aria-label="Copy webhook URL"
      className="group gw-focus-ring -my-1 flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-[6px] border-none bg-transparent px-0 py-1 text-left transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.05)]"
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" style={{ color: "var(--gw-t6)" }}>
        {url}
      </span>
      <Copy
        size={11}
        strokeWidth={1.9}
        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        style={{ color: "var(--gw-t8)" }}
      />
    </button>
  );
}

/** Flat hairline row (manifest S7.1, restructured): chip/status/attempt and
 *  url/error on the left, time and Retry in their own right-aligned column
 *  — ActivityRow's layout, so the two log tabs scan the same way. */
function DeliveryRow({
  delivery,
  onRetry,
  isRetrying,
}: {
  delivery: WebhookDelivery;
  onRetry: () => void;
  isRetrying: boolean;
}) {
  const tone = deliveryStatusTone(delivery.status);

  return (
    <div
      className="flex items-start gap-3 px-0.5 py-3.5"
      style={{ borderBottom: "1px solid rgba(var(--gw-line-rgb),.05)" }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="shrink-0 rounded-[5px] px-[7px] py-0.5 font-mono text-[11px]"
            style={{ background: "rgba(var(--gw-line-rgb),.05)", color: "var(--gw-t5)" }}
          >
            {delivery.event_type}
          </span>
          {tone && (
            <StatusBadge variant="filled" tone={tone === "failed" ? "red" : "amber"}>
              {tone}
            </StatusBadge>
          )}
          <span className="truncate font-mono text-[11px]" style={{ color: "var(--gw-t7)" }}>
            {deliveryMeta(delivery).join(" ")}
          </span>
        </div>
        <DeliveryUrl url={delivery.url} />
        {tone === "failed" && <ErrorLine error={delivery.last_error} />}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <span className="font-mono text-[11px]" style={{ color: "var(--gw-t8)" }}>
          {timeAgoShort(deliveryTimestamp(delivery))}
        </span>
        {canRetryDelivery(delivery.status) && (
          <ActionLink
            ariaLabel="Retry delivery"
            onClick={() => {
              if (!isRetrying) onRetry();
            }}
          >
            {isRetrying ? "Retrying…" : "Retry"}
          </ActionLink>
        )}
      </div>
    </div>
  );
}

export function DeliveriesPane() {
  const queryClient = useQueryClient();
  const [filters, setFiltersState] = useState<DeliveryFilters>(EMPTY_DELIVERY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<WebhookDelivery[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  // Instant-apply, unlike Activity's Apply button — status is a one-click
  // choice and a date range only ever changes via the native picker
  // settling on a full date, neither warrants a confirm step.
  function updateFilters(patch: Partial<DeliveryFilters>) {
    setFiltersState((f) => ({ ...f, ...patch }));
    setOffset(0);
    setItems([]);
  }

  function clearFilters() {
    setFiltersState(EMPTY_DELIVERY_FILTERS);
    setOffset(0);
    setItems([]);
  }

  const { isLoading, error, isFetching } = useQuery({
    queryKey: ["settings", "deliveries", filters, offset],
    queryFn: async () => {
      const res = await listDeliveries(buildDeliveryParams(filters, offset));
      setItems((prev) => appendDeliveriesPage(prev, res.items, offset));
      setHasMore(res.has_more);
      return res;
    },
  });

  const retryMutation = useMutation({
    mutationFn: (id: string) => retryDelivery(id),
    onMutate: (id: string) => setRetryingId(id),
    onSettled: () => setRetryingId(null),
    onSuccess: () => {
      toast.success("Retry queued");
      void queryClient.invalidateQueries({ queryKey: ["settings", "deliveries"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Failed to retry delivery");
    },
  });

  return (
    <div className="flex w-full flex-col gap-[26px]">
      <div className="flex flex-wrap items-end gap-2.5">
        <FilterField label="Status">
          <div className="max-w-[420px] min-w-[280px]">
            <SegmentedTabs
              tabs={STATUS_TABS}
              active={filters.status}
              onChange={(v) => updateFilters({ status: v })}
              ariaLabel="Filter by status"
              equalWidth
            />
          </div>
        </FilterField>
        <FilterField label="Event type">
          <MultiSelectFilterMenu
            value={filters.eventType}
            onChange={(next) => updateFilters({ eventType: next })}
            options={DELIVERY_EVENT_TYPES}
            allLabel="All events"
            pluralNoun="events"
            ariaLabel="Filter by event type"
            searchPlaceholder="Search events…"
          />
        </FilterField>
        <FilterField label="Date range">
          <DateRangePopover
            dateFrom={filters.dateFrom}
            dateTo={filters.dateTo}
            onChange={(dateFrom, dateTo) => updateFilters({ dateFrom, dateTo })}
          />
        </FilterField>
        {hasActiveDismissableDeliveryFilters(filters) && (
          <div className="flex h-[35px] shrink-0 items-center">
            <ActionLink onClick={clearFilters}>Clear</ActionLink>
          </div>
        )}
      </div>

      {error ? (
        <EmptyState title="Failed to load deliveries" hint={error instanceof Error ? error.message : undefined} />
      ) : isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 size={16} className="animate-spin" style={{ color: "var(--gw-t8)" }} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState title={hasActiveDeliveryFilters(filters) ? "No matching deliveries" : "No deliveries yet"} />
      ) : (
        <div className="flex flex-col">
          {items.map((d) => (
            <DeliveryRow
              key={d.id}
              delivery={d}
              onRetry={() => retryMutation.mutate(d.id)}
              isRetrying={retryingId === d.id}
            />
          ))}
        </div>
      )}

      {hasMore && !isLoading && items.length > 0 && (
        <div className="flex justify-center pt-1">
          <AddLink onClick={() => setOffset((o) => o + DELIVERIES_PAGE_SIZE)} disabled={isFetching}>
            {isFetching ? "Loading…" : "Load more"}
          </AddLink>
        </div>
      )}
    </div>
  );
}

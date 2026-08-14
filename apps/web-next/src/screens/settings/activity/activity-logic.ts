/**
 * activity-logic.ts — pure helpers for the Activity (audit log) pane.
 * web-next has no render harness, so all branching/formatting logic lives
 * here and is unit-tested; the pane component is a thin shell over these
 * functions (same split as integrations-logic.ts / notification-prefs-logic.ts).
 */
import type { AuditEvent, ListAuditParams } from "@gatewerk/web-core/api/audit";
import { endOfDayIso, startOfDayIso } from "@gatewerk/web-core/lib/filter-dates";

export interface ActivityFilters {
  /** Zero or more actions to match any of (Activity's multi-select filter). */
  action: string[];
  resourceType: string;
  /** Bare `YYYY-MM-DD` from the date inputs, or "" for unset. Converted to
   *  instants only at the API-params boundary (buildAuditParams) — the
   *  filter state itself stays in the same shape the <input type="date">
   *  elements speak. */
  dateFrom: string;
  dateTo: string;
}

export const EMPTY_ACTIVITY_FILTERS: ActivityFilters = {
  action: [],
  resourceType: "",
  dateFrom: "",
  dateTo: "",
};

export const ACTIVITY_PAGE_SIZE = 50;

/**
 * GET /api/v1/audit params for one page. `actor` is deliberately absent:
 * apps/web's ActivityPane filters by actor too, but packages/web-core's
 * ListAuditParams has no actor field, and inventing one here would call an
 * endpoint capability that does not exist. See ActivityPane.tsx's file doc.
 */
export function buildAuditParams(filters: ActivityFilters, offset: number): ListAuditParams {
  return {
    ...(filters.action.length > 0 && { action: filters.action }),
    ...(filters.resourceType && { resource_type: filters.resourceType }),
    ...(filters.dateFrom && { from: startOfDayIso(filters.dateFrom) }),
    ...(filters.dateTo && { to: endOfDayIso(filters.dateTo) }),
    limit: ACTIVITY_PAGE_SIZE,
    offset,
  };
}

export function hasActiveActivityFilters(filters: ActivityFilters): boolean {
  return (
    filters.action.length > 0 ||
    filters.resourceType !== "" ||
    filters.dateFrom !== "" ||
    filters.dateTo !== ""
  );
}

/**
 * Merge one fetched page into the running list. Offset 0 is a fresh search
 * (new filters or Clear) and replaces; any later offset is a "Load more"
 * page and appends.
 */
export function appendActivityPage(
  prev: AuditEvent[],
  page: AuditEvent[],
  offset: number,
): AuditEvent[] {
  return offset === 0 ? page : [...prev, ...page];
}

/**
 * The mono meta line under the actor row: resource type, and the first 8
 * chars of the resource id when one exists. The action itself is not
 * repeated here — it is already the ActorRow role above. Lowercase, space
 * separated, ApiKeyRow's meta-line grammar.
 */
export function activityEventMeta(event: Pick<AuditEvent, "resource_type" | "resource_id">): string[] {
  const meta = [event.resource_type];
  if (event.resource_id) meta.push(event.resource_id.slice(0, 8));
  return meta;
}

/**
 * route-queries — the single catalog of query options shared by screens and
 * the prefetch layer (src/prefetch.ts). A screen's useQuery and the prefetch
 * fired at navigation MUST be the same cache entry; importing the same
 * constant from here is what guarantees the keys cannot drift.
 *
 * staleTime values are carried here for the same reason: a prefetch with a
 * different staleTime than the mounted query would refetch anyway.
 */
import { listReviews, reviews } from "@gatewerk/web-core/api/reviews";
import { getProjectSettings, getHmacSecretPreview } from "@gatewerk/web-core/api/projects";
import { listTeam } from "@gatewerk/web-core/api/notifications";
import { listApiKeys } from "@gatewerk/web-core/api/api-keys";
import { listWebhooks } from "@gatewerk/web-core/api/webhooks";
import { listNotes, listNoteTags } from "@gatewerk/web-core/api/notes";
import { templates } from "@gatewerk/web-core/api/templates";
import { listNotifications, unreadCount } from "~/api/notifications";

export const HISTORY_PAGE_SIZE = 50;
export const NOTES_PAGE_SIZE = 100;

/**
 * ["templates"] deliberately, not listTemplates' ["templates","list"]:
 * detail and stats sit under ["templates","detail",id] / ["templates","stats",id]
 * and this key is the invalidation prefix for all three (Templates.tsx doc).
 */
export const TEMPLATES_QUERY_KEY = ["templates"] as const;

export const inboxReviewsQuery = listReviews({ limit: 100 });
export const notificationsQuery = {
  queryKey: ["notifications"] as const,
  queryFn: listNotifications,
};

export const pendingBadgeQuery = {
  queryKey: ["reviews", "pending"] as const,
  queryFn: () => reviews.list({ status: "pending" }),
  staleTime: 30_000,
};
export const unreadCountQuery = {
  queryKey: ["notifications", "unread-count"] as const,
  queryFn: unreadCount,
};

export const templatesQuery = {
  queryKey: TEMPLATES_QUERY_KEY,
  queryFn: templates.list,
  staleTime: 300_000,
};

export const historyDecidedQuery = {
  queryKey: ["reviews", "history", "decided"] as const,
  queryFn: () => reviews.list({ status: "decided", limit: HISTORY_PAGE_SIZE }),
};
export const historyExpiredQuery = {
  queryKey: ["reviews", "history", "expired"] as const,
  queryFn: () => reviews.list({ status: "expired", limit: HISTORY_PAGE_SIZE }),
};

export const projectSettingsQuery = getProjectSettings({});
export const teamQuery = listTeam({});
export const apiKeysQuery = listApiKeys({});
export const webhooksQuery = listWebhooks({});
export const hmacPreviewQuery = getHmacSecretPreview({});

export function notesListQuery(projectId: string) {
  return listNotes({ project_id: projectId, limit: NOTES_PAGE_SIZE });
}
export function noteTagsQuery(projectId: string) {
  return listNoteTags({ project_id: projectId });
}

interface PrefetchableQuery {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  staleTime?: number;
}

/** Always-on shell queries (badge pair), prefetched once at boot. */
export function shellQueries(): PrefetchableQuery[] {
  return [pendingBadgeQuery, unreadCountQuery];
}

/**
 * The queries a screen will mount for a given pathname. Notes' id-dependent
 * pair (notes list + tags) is NOT here — it needs the project id first; the
 * chain lives in prefetchRoute (src/prefetch.ts).
 */
export function routeQueries(pathname: string): PrefetchableQuery[] {
  if (pathname === "/") return [inboxReviewsQuery, notificationsQuery];
  if (pathname.startsWith("/history")) return [historyDecidedQuery, historyExpiredQuery];
  if (pathname.startsWith("/templates")) return [templatesQuery];
  if (pathname.startsWith("/notes")) return [projectSettingsQuery];
  if (pathname === "/settings/project")
    return [projectSettingsQuery, teamQuery, apiKeysQuery, webhooksQuery, hmacPreviewQuery, templatesQuery];
  return [];
}

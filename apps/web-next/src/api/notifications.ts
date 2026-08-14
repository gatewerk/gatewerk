/**
 * notifications.ts — API client for in-app notification endpoints.
 *
 * Endpoints:
 *   GET  /api/v1/notifications               → { notifications }
 *   GET  /api/v1/notifications/unread-count  → { count }
 *   POST /api/v1/reviews/:id/seen            → 204
 *
 * Uses the same `request` wrapper as all web/src/api/* clients.
 */
import { request } from "@gatewerk/web-core/api/client/http";

export interface Notification {
  id: string;
  review_id: string | null;
  read_at: string | null;
  [key: string]: unknown;
}

export function listNotifications(): Promise<{ notifications: Notification[] }> {
  return request<{ notifications: Notification[] }>("/api/v1/notifications");
}

export function unreadCount(): Promise<{ count: number }> {
  return request<{ count: number }>("/api/v1/notifications/unread-count");
}

export function markSeen(reviewId: string): Promise<void> {
  return request<void>(`/api/v1/reviews/${reviewId}/seen`, { method: "POST" });
}

/**
 * Pure function: returns the set of review_id values that have at least one
 * unread (read_at === null) notification.
 *
 * Rows with a null review_id are skipped (they are not associated with a
 * specific review and cannot produce a per-row dot).
 */
export function unreadReviewIdSet(notifications: Notification[]): Set<string> {
  const set = new Set<string>();
  for (const n of notifications) {
    if (n.review_id !== null && n.read_at === null) {
      set.add(n.review_id);
    }
  }
  return set;
}

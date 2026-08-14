/**
 * preferences.ts — API client for GET/PUT /api/v1/auth/preferences.
 *
 * Uses the same `request` wrapper as all web/src/api/* clients (apps/web/src
 * is aliased to "@" in web-next). Handles auth headers and 401 redirect
 * automatically.
 */
import { request } from "@gatewerk/web-core/api/client/http";
import type { NotificationPrefs } from "@gatewerk/shared";

export interface PreferencesResponse {
  login_notifications: boolean;
  notifications: NotificationPrefs;
}

export function getPreferences(): Promise<PreferencesResponse> {
  return request<PreferencesResponse>("/api/v1/auth/preferences");
}

export function updatePreferences(body: {
  notifications?: NotificationPrefs;
  login_notifications?: boolean;
}): Promise<void> {
  return request<void>("/api/v1/auth/preferences", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

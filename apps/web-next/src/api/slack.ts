/**
 * slack.ts — API client for the Slack connection endpoints (Stage 4a/4b).
 *
 * Uses the shared `request` wrapper from @gatewerk/web-core, which attaches
 * the bearer token and handles 401. Because auth is
 * a bearer header (not a cookie), the "Add to Slack" flow must fetch the
 * authorize URL here and then navigate the browser to it — a plain anchor to
 * /install would arrive unauthenticated.
 */
import { request } from "@gatewerk/web-core/api/client/http";

export type SlackStatus =
  | { connected: false }
  | { connected: true; team_name: string; lookup_failed: boolean };

export function getSlackStatus(): Promise<SlackStatus> {
  return request<SlackStatus>("/api/v1/slack/status");
}

export async function getSlackInstallUrl(): Promise<string> {
  const { url } = await request<{ url: string }>("/api/v1/slack/install");
  return url;
}

export function disconnectSlack(): Promise<void> {
  return request<void>("/api/v1/slack/disconnect", { method: "POST" });
}

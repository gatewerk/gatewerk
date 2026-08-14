/**
 * integrations-logic.ts — pure helpers for the Slack Integrations pane.
 * web-next has no render harness, so all branching logic lives here and is
 * unit-tested; the pane component is a thin shell over these functions.
 */
import type { SlackStatus } from "~/api/slack";

export type IntegrationsView =
  | { kind: "loading" }
  | { kind: "disconnected" }
  | { kind: "connected"; teamName: string; lookupFailed: boolean };

/** Derive the render view. Fail safe: unknown/missing status -> disconnected. */
export function toIntegrationsView(args: {
  isLoading: boolean;
  status: SlackStatus | undefined;
}): IntegrationsView {
  if (args.isLoading) return { kind: "loading" };
  if (args.status?.connected) {
    return {
      kind: "connected",
      teamName: args.status.team_name,
      lookupFailed: args.status.lookup_failed,
    };
  }
  return { kind: "disconnected" };
}

/** The OAuth callback redirects to /settings/integrations?slack=connected. */
export function shouldToastConnected(slackParam: string | null): boolean {
  return slackParam === "connected";
}

export type DisconnectConfirm = "idle" | "confirming";
export type DisconnectAction = "request" | "cancel" | "confirm";

export function nextDisconnectConfirm(
  current: DisconnectConfirm,
  action: DisconnectAction,
): DisconnectConfirm {
  if (action === "request") return "confirming";
  return "idle"; // cancel or confirm both return to idle
}

/** The Slack preference column is only usable once a workspace is connected. */
export function isSlackChannelDisabled(slackConnected: boolean): boolean {
  return !slackConnected;
}

/** Exhaustiveness guard for the IntegrationsView switch (Global Constraint). */
export function assertNever(x: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(x)}`);
}

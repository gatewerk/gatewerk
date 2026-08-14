import { describe, it, expect } from "vitest";
import {
  toIntegrationsView,
  shouldToastConnected,
  nextDisconnectConfirm,
  isSlackChannelDisabled,
} from "./integrations-logic";

describe("toIntegrationsView", () => {
  it("is loading while the query is pending", () => {
    expect(toIntegrationsView({ isLoading: true, status: undefined })).toEqual({
      kind: "loading",
    });
  });
  it("is disconnected when status says not connected", () => {
    expect(
      toIntegrationsView({ isLoading: false, status: { connected: false } }),
    ).toEqual({ kind: "disconnected" });
  });
  it("is disconnected when status is missing and not loading (fail-safe)", () => {
    expect(
      toIntegrationsView({ isLoading: false, status: undefined }),
    ).toEqual({ kind: "disconnected" });
  });
  it("is connected with the team name", () => {
    expect(
      toIntegrationsView({
        isLoading: false,
        status: { connected: true, team_name: "Acme", lookup_failed: false },
      }),
    ).toEqual({ kind: "connected", teamName: "Acme", lookupFailed: false });
  });
  it("carries lookupFailed through when the Slack account lookup failed", () => {
    expect(
      toIntegrationsView({
        isLoading: false,
        status: { connected: true, team_name: "Acme", lookup_failed: true },
      }),
    ).toEqual({ kind: "connected", teamName: "Acme", lookupFailed: true });
  });
});

describe("shouldToastConnected", () => {
  it("true only for the 'connected' param", () => {
    expect(shouldToastConnected("connected")).toBe(true);
    expect(shouldToastConnected(null)).toBe(false);
    expect(shouldToastConnected("error")).toBe(false);
  });
});

describe("nextDisconnectConfirm", () => {
  it("request moves idle -> confirming", () => {
    expect(nextDisconnectConfirm("idle", "request")).toBe("confirming");
  });
  it("cancel and confirm return to idle", () => {
    expect(nextDisconnectConfirm("confirming", "cancel")).toBe("idle");
    expect(nextDisconnectConfirm("confirming", "confirm")).toBe("idle");
  });
});

describe("isSlackChannelDisabled", () => {
  it("disabled unless connected", () => {
    expect(isSlackChannelDisabled(false)).toBe(true);
    expect(isSlackChannelDisabled(true)).toBe(false);
  });
});

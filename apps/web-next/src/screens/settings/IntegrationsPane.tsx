/**
 * IntegrationsPane — connect / disconnect Slack for personal notifications.
 *
 * Bearer-auth SPA: the "Add to Slack" button fetches the authorize URL via the
 * authenticated request wrapper, then navigates the browser to it (a plain
 * anchor to /install would arrive without the token and 401). Connection state
 * is a single useQuery(['slack-status']); connect/disconnect invalidate it.
 *
 * Styling: theme tokens only, elevation-only cards, no dashes in copy.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MessageSquare } from "lucide-react";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { CARD_SHELL, SectionRule } from "./_shared/ui";
import { getSlackStatus, getSlackInstallUrl, disconnectSlack } from "~/api/slack";
import {
  toIntegrationsView,
  shouldToastConnected,
  nextDisconnectConfirm,
  assertNever,
  type DisconnectConfirm,
} from "./integrations-logic";

export function IntegrationsPane() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [confirm, setConfirm] = useState<DisconnectConfirm>("idle");

  const { data: status, isLoading } = useQuery({
    queryKey: ["slack-status"],
    queryFn: getSlackStatus,
    staleTime: 30_000,
  });

  // The OAuth callback bounces back with ?slack=connected — toast once, then
  // strip the param so a refresh does not re-toast.
  useEffect(() => {
    if (shouldToastConnected(searchParams.get("slack"))) {
      toast.success("Slack connected");
      void queryClient.invalidateQueries({ queryKey: ["slack-status"] });
      const next = new URLSearchParams(searchParams);
      next.delete("slack");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape cancels the disconnect confirm (Global Constraint).
  useEffect(() => {
    if (confirm !== "confirming") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setConfirm(nextDisconnectConfirm("confirming", "cancel"));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm]);

  const [connecting, setConnecting] = useState(false);
  async function handleConnect() {
    setConnecting(true);
    try {
      const url = await getSlackInstallUrl();
      window.location.href = url;
    } catch {
      toast.error("Could not start Slack connection");
      setConnecting(false);
    }
  }

  const disconnectMutation = useMutation({
    mutationFn: disconnectSlack,
    onSuccess: () => {
      toast.success("Slack disconnected");
      void queryClient.invalidateQueries({ queryKey: ["slack-status"] });
      setConfirm(nextDisconnectConfirm("confirming", "confirm"));
    },
    onError: () => {
      toast.error("Could not disconnect Slack");
      setConfirm(nextDisconnectConfirm("confirming", "cancel"));
    },
  });

  const view = toIntegrationsView({ isLoading, status });

  return (
    <section className="flex flex-col gap-3">
      <SectionRule label="Integrations" />
      <p className="m-0 mb-1 text-[12px]" style={{ color: "var(--gw-t7)" }}>
        Connect Slack to receive a direct message when a review needs you.
      </p>

      <div className="flex items-center justify-between" style={CARD_SHELL}>
        <div className="flex items-center gap-3">
          <MessageSquare size={20} strokeWidth={1.5} style={{ color: "var(--gw-t3)" }} />
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium" style={{ color: "var(--gw-t2)" }}>
              Slack
            </span>
            <span className="text-[11px]" style={{ color: "var(--gw-t7)" }}>
              {renderStatusLine(view)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">{renderAction()}</div>
      </div>

      {view.kind === "connected" && view.lookupFailed && (
        <p
          className="mt-3 rounded-lg px-4 py-3 text-[12px]"
          style={{
            background: "rgba(var(--gw-amber-rgb),.08)",
            border: "1px solid rgba(var(--gw-amber-rgb),.3)",
            // amber-hi, not amber-t: on the amber tint the -t ink composites
            // to ~4.3:1 in light; -hi is the stronger amber on both themes.
            color: "var(--gw-amber-hi)",
          }}
        >
          {`Connected to ${view.teamName}, but we could not find a Slack account for ${user?.email ?? "your account"}. Notifications will arrive by email instead.`}
        </p>
      )}
    </section>
  );

  function renderStatusLine(v: ReturnType<typeof toIntegrationsView>): string {
    switch (v.kind) {
      case "loading":
        return "Checking connection";
      case "disconnected":
        return "Not connected";
      case "connected":
        return `Connected to ${v.teamName}`;
      default:
        return assertNever(v);
    }
  }

  function renderAction() {
    switch (view.kind) {
      case "loading":
        return null;
      case "disconnected":
        return (
          <button
            type="button"
            onClick={handleConnect}
            disabled={connecting}
            className="cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors duration-150"
            style={{ background: "rgba(var(--gw-hi-rgb),.12)", color: "var(--gw-t2)" }}
          >
            {connecting ? "Opening Slack" : "Add to Slack"}
          </button>
        );
      case "connected":
        return confirm === "confirming" ? (
          <>
            <button
              type="button"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
              className="cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-medium"
              style={{ background: "rgba(var(--gw-red-rgb),.14)", color: "var(--gw-red-t)" }}
            >
              Confirm disconnect
            </button>
            <button
              type="button"
              onClick={() => setConfirm(nextDisconnectConfirm("confirming", "cancel"))}
              className="cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-medium"
              style={{ color: "var(--gw-t6)" }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirm(nextDisconnectConfirm("idle", "request"))}
            className="cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-medium"
            style={{ color: "var(--gw-t6)" }}
          >
            Disconnect
          </button>
        );
      default:
        return assertNever(view);
    }
  }
}

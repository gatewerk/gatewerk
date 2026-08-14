/**
 * Active sessions — the prototype's Security card (manifest S9.4), against
 * the real sessions API. Every behavior is live: per-session Revoke,
 * Sign out all others, and a CURRENT badge on the session you are reading
 * this from (green: it is a live fact about right now, not configuration).
 *
 * Revoking is direct with a toast, no confirm — a revoked session recovers
 * by signing in again, unlike the pane's genuinely destructive neighbors.
 *
 * Sessions come back newest-`last_active_at`-first (services/sessions.ts's
 * `listForReviewer`) — the card trusts that order rather than re-sorting.
 * The card itself shows only the first `VISIBLE_SESSION_LIMIT`; a reviewer
 * with many devices/browsers otherwise pushes the rest of Security off
 * screen. "Show all" opens the full list in a modal, the app's standing
 * dialog idiom (scrim + `role="dialog"` card + `--gw-modal-rgb`, Escape at
 * capture — ActionModal.tsx, RecipientActionModal.tsx, ShareModal.tsx).
 */
import { useEffect, useState } from "react";
import { Monitor, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { listSessions, revokeAllSessions, revokeSession, type Session } from "@gatewerk/web-core/api/sessions";
import { timeAgo } from "@gatewerk/web-core/lib/utils";
import { ActionLink, CARD_SHELL } from "../_shared/ui";

const VISIBLE_SESSION_LIMIT = 5;

/** Same three-line UA parse login history uses, kept Title Case here because
 * the device string is the row's primary label, not a meta line. */
function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser =
    ua.match(/Chrome\/[\d.]+/i)?.[0]?.replace("/", " ") ??
    ua.match(/Firefox\/[\d.]+/i)?.[0]?.replace("/", " ") ??
    ua.match(/Safari\/[\d.]+/i)?.[0]?.replace("/", " ") ??
    "Unknown browser";
  const os = /mac os/i.test(ua) ? "macOS" : /windows/i.test(ua) ? "Windows" : /linux/i.test(ua) ? "Linux" : "";
  return os ? `${browser}, ${os}` : browser;
}

function SessionRow({ session, onRevoke }: { session: Session; onRevoke: () => void }) {
  return (
    <div
      className="flex items-center gap-3 py-[11px]"
      style={{ borderBottom: "1px solid rgba(var(--gw-line-rgb),.05)" }}
    >
      <Monitor size={16} strokeWidth={1.7} className="shrink-0" style={{ color: "var(--gw-t8)" }} />
      {/* Device + CURRENT badge — the row's only flexible column, so it
          absorbs whatever width IP / last active / Revoke don't need
          instead of those three being crammed into a mono sub line
          underneath it (the row's width is used
          honestly). IP and last active keep their natural (not fixed)
          width so this still reads right in the narrower "Show all"
          modal (max-w-[440px] below), not just the wide card. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-[13px]" style={{ color: "var(--gw-t3)" }}>
          {deviceLabel(session.user_agent)}
        </span>
        {session.is_current && (
          <span
            className="shrink-0 rounded-[4px] font-mono text-[9px] font-semibold uppercase"
            style={{
              letterSpacing: ".08em",
              color: "var(--gw-green-d)",
              background: "rgba(33,181,113,.12)",
              padding: "2px 6px",
            }}
          >
            Current
          </span>
        )}
      </div>
      {/* IP and last active — still mono (machine values, the app's standing
          treatment for them everywhere else), now laid out across the row
          instead of stacked together under the device label. */}
      <span className="shrink-0 whitespace-nowrap font-mono text-[11px]" style={{ color: "var(--gw-t8)" }}>
        {session.ip_address ?? "unknown ip"}
      </span>
      <span className="shrink-0 whitespace-nowrap font-mono text-[11px]" style={{ color: "var(--gw-t8)" }}>
        last active {timeAgo(session.last_active_at)}
      </span>
      <span className="flex w-[50px] shrink-0 justify-end">
        {!session.is_current && <ActionLink onClick={onRevoke}>Revoke</ActionLink>}
      </span>
    </div>
  );
}

/** Full session list, in a modal — the "Show all" overflow for a card that
 *  otherwise renders only VISIBLE_SESSION_LIMIT rows. */
function SessionsModal({
  sessions,
  others,
  onRevoke,
  onRevokeAll,
  onClose,
}: {
  sessions: Session[];
  others: number;
  onRevoke: (id: string) => void;
  onRevokeAll: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      onClose();
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[80] flex items-center justify-center p-6"
      style={{ background: "rgba(10,10,8,.55)", backdropFilter: "blur(5px)", WebkitBackdropFilter: "blur(5px)" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="All active sessions"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[440px] flex-col"
        style={{
          maxHeight: "80vh",
          background: "rgba(var(--gw-modal-rgb),.96)",
          backdropFilter: "blur(24px) saturate(150%)",
          WebkitBackdropFilter: "blur(24px) saturate(150%)",
          border: "1px solid rgba(var(--gw-line-rgb),.14)",
          borderRadius: 16,
          boxShadow: "0 32px 80px rgba(0,0,0,.58), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
          padding: "20px 20px 8px",
        }}
      >
        <div className="mb-1.5 flex items-center gap-3.5">
          <span className="flex-1 text-[15px] font-semibold" style={{ color: "var(--gw-t2)" }}>
            Active sessions
          </span>
          {others > 0 && <ActionLink onClick={onRevokeAll}>Sign out all others</ActionLink>}
          <button
            type="button"
            title="Close"
            aria-label="Close"
            onClick={onClose}
            className="gw-focus-ring flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] border-none bg-transparent transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)]"
            style={{ color: "var(--gw-t8)" }}
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex flex-col overflow-y-auto pb-3">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} onRevoke={() => onRevoke(s.id)} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function SessionsCard() {
  const queryClient = useQueryClient();
  const [showAll, setShowAll] = useState(false);

  const { data } = useQuery({ queryKey: ["settings", "sessions"], queryFn: listSessions });
  const sessions = data?.items ?? [];

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["settings", "sessions"] });
  }

  function onError(err: unknown) {
    toast.error(err instanceof Error ? err.message : "Request failed");
  }

  const revokeMutation = useMutation({
    mutationFn: revokeSession,
    onSuccess: () => {
      invalidate();
      toast.success("Session revoked");
    },
    onError,
  });

  const revokeAllMutation = useMutation({
    mutationFn: revokeAllSessions,
    onSuccess: (result) => {
      invalidate();
      toast.success(
        result.revoked_count === 1
          ? "Signed out 1 other session"
          : `Signed out ${result.revoked_count} other sessions`,
      );
    },
    onError,
  });

  const others = sessions.filter((s) => !s.is_current).length;
  const visible = sessions.slice(0, VISIBLE_SESSION_LIMIT);
  const overflow = sessions.length - visible.length;

  return (
    <div style={CARD_SHELL}>
      <div className="mb-1.5 flex items-center gap-3.5">
        <span className="flex-1 text-[14px] font-semibold" style={{ color: "var(--gw-t2)" }}>
          Active sessions
        </span>
        {others > 0 && (
          <ActionLink onClick={() => revokeAllMutation.mutate()}>Sign out all others</ActionLink>
        )}
      </div>
      {visible.map((s) => (
        <SessionRow key={s.id} session={s} onRevoke={() => revokeMutation.mutate(s.id)} />
      ))}
      {overflow > 0 && (
        <div className="flex justify-center pt-2.5">
          <ActionLink onClick={() => setShowAll(true)}>Show all {sessions.length} sessions</ActionLink>
        </div>
      )}
      {showAll && (
        <SessionsModal
          sessions={sessions}
          others={others}
          onRevoke={(id) => revokeMutation.mutate(id)}
          onRevokeAll={() => revokeAllMutation.mutate()}
          onClose={() => setShowAll(false)}
        />
      )}
    </div>
  );
}

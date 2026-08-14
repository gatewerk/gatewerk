/**
 * LoginHistorySection — sign-in event history, in the api-keys pane's item
 * list grammar (SectionHeader + rounded-[11px] CARD_STYLE rows, ApiKeyRow's
 * lowercase mono meta line). Login history is EVIDENCE, not a setting: rows
 * never invite editing, and a failed sign in is the one place color marks
 * live attention here, a red badge in the same language as ApiKeyRow's
 * "expired" pill.
 *
 * Behavior and copy ported from
 * apps/web/src/pages/settings/security/LoginHistorySection.tsx (its markup
 * and Tailwind classes are apps/web only — web-next's Tailwind build never
 * scans that tree and its shadcn tokens do not exist here). One behavior
 * change: rows show relative time (timeAgo, ApiKeyRow's own convention on
 * this screen) instead of the reference's absolute timestamp.
 *
 * Sessions treatment applied here too (SessionsCard.tsx): the section shows
 * only the first VISIBLE_LIMIT rows, with "Show full history" opening the
 * rest in a modal — the app's standing dialog idiom. Unlike sessions, this
 * list is genuinely unbounded (an audit-log-backed history, not a handful of
 * live devices), so it keeps its real offset pagination — that "Load more"
 * machinery just moves into the modal instead of growing the inline card.
 * The server already returns newest-first (login-history.ts's
 * `orderBy(desc(auditLog.created_at))`), so no client-side sort is needed.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { getLoginHistory, type LoginHistoryItem } from "@gatewerk/web-core/api/login-history";
import { timeAgo } from "@gatewerk/web-core/lib/utils";
import { EmptyState, GhostButton } from "../../templates/_ui";
import { ActionLink, SectionRule } from "../_shared/ui";

const ACTION_LABELS: Record<string, string> = {
  "auth.login_success": "Signed in",
  "auth.login_failure": "Failed sign in",
  "auth.logout": "Signed out",
  "auth.lockout": "Account locked",
  "auth.2fa_validated": "2FA verified",
  "session.revoked": "Session revoked",
  "session.revoke_all": "All sessions revoked",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function isFailure(action: string): boolean {
  return action === "auth.login_failure" || action === "auth.lockout";
}

// Same three-line parse SecurityPane.tsx uses for active sessions' user
// agent (apps/web/src/pages/settings/security/SecurityPane.tsx:14) — no
// shared util exists yet for this, so the regex is ported as is.
function parseDevice(ua: string | null): string {
  if (!ua) return "";
  const browser =
    ua.match(/chrome\/[\d.]+/i)?.[0]?.replace("/", " ") ??
    ua.match(/firefox\/[\d.]+/i)?.[0]?.replace("/", " ") ??
    ua.match(/safari\/[\d.]+/i)?.[0]?.replace("/", " ") ??
    "";
  const os = /mac os/i.test(ua) ? "macos" : /windows/i.test(ua) ? "windows" : /linux/i.test(ua) ? "linux" : "";
  return [browser.toLowerCase(), os].filter(Boolean).join(" ");
}

function HistoryRow({ item }: { item: LoginHistoryItem }) {
  const failed = isFailure(item.action);
  const device = parseDevice(item.user_agent);
  const meta = [item.ip_address ?? "unknown ip", device, timeAgo(item.timestamp)].filter(Boolean);

  return (
    <div
      className="flex items-center gap-3 py-[11px]"
      style={{ borderBottom: "1px solid rgba(var(--gw-line-rgb),.05)" }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium" style={{ color: "var(--gw-t2)" }}>
            {actionLabel(item.action)}
          </span>
          {failed && (
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ background: "rgba(var(--gw-red-rgb),.14)", color: "var(--gw-red-t)" }}
            >
              failed
            </span>
          )}
        </div>
        <span className="truncate font-mono text-[11px]" style={{ color: "var(--gw-t7)" }}>
          {meta.join("  ")}
        </span>
      </div>
    </div>
  );
}

const PAGE_SIZE = 20;
const VISIBLE_LIMIT = 5;

/** Full history, in a modal — the "Show full history" overflow for a
 *  section that otherwise renders only VISIBLE_LIMIT rows. Carries on the
 *  parent's own offset pagination rather than owning a second copy of it. */
function LoginHistoryModal({
  items,
  hasMore,
  isFetching,
  onLoadMore,
  onClose,
}: {
  items: LoginHistoryItem[];
  hasMore: boolean;
  isFetching: boolean;
  onLoadMore: () => void;
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
        aria-label="Login history"
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
            Login history
          </span>
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
          {items.map((item, i) => (
            <HistoryRow key={i} item={item} />
          ))}
          {hasMore && (
            <div className="flex justify-center py-3">
              <GhostButton onClick={onLoadMore} disabled={isFetching}>
                {isFetching ? "Loading" : "Load more"}
              </GhostButton>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function LoginHistorySection() {
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<LoginHistoryItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const { isLoading, isFetching, error } = useQuery({
    queryKey: ["settings", "login-history", offset],
    queryFn: async () => {
      const res = await getLoginHistory(PAGE_SIZE, offset);
      setItems((prev) => (offset === 0 ? res.items : [...prev, ...res.items]));
      setHasMore(res.has_more);
      return res;
    },
  });

  const visible = items.slice(0, VISIBLE_LIMIT);
  const overflow = items.length > VISIBLE_LIMIT || hasMore;

  return (
    <section className="flex flex-col gap-3">
      <SectionRule label="Login history" />

      {isLoading && offset === 0 ? (
        <div className="flex justify-center py-8">
          <Loader2 size={16} className="animate-spin" style={{ color: "var(--gw-t8)" }} />
        </div>
      ) : error ? (
        <EmptyState
          title="Could not load login history"
          hint={error instanceof Error ? error.message : undefined}
        />
      ) : items.length === 0 ? (
        <EmptyState title="No recent activity" />
      ) : (
        <>
          <div className="flex flex-col">
            {visible.map((item, i) => (
              <HistoryRow key={i} item={item} />
            ))}
          </div>
          {overflow && (
            <div className="flex justify-center pt-0.5">
              <ActionLink onClick={() => setShowAll(true)}>Show full history</ActionLink>
            </div>
          )}
        </>
      )}

      {showAll && (
        <LoginHistoryModal
          items={items}
          hasMore={hasMore}
          isFetching={isFetching}
          onLoadMore={() => setOffset((o) => o + PAGE_SIZE)}
          onClose={() => setShowAll(false)}
        />
      )}
    </section>
  );
}

import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Inbox,
  Clock,
  SquareStack,
  StickyNote,
  Settings,
  User,
  PanelLeft,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Logo } from "./Logo";
import { prefetchRoute } from "~/prefetch";

interface DrawerItem {
  to: string;
  icon: LucideIcon;
  label: string;
  matchPrefix?: string;
  pushToBottom?: boolean;
}

const DRAWER_ITEMS: DrawerItem[] = [
  { to: "/", icon: Inbox, label: "Inbox" },
  { to: "/history", icon: Clock, label: "History" },
  { to: "/templates", icon: SquareStack, label: "Templates" },
  { to: "/notes", icon: StickyNote, label: "Notes" },
  // Metrics has no destination at launch; see the note in App.tsx. When it
  // returns it belongs in the icon rail, not here.
  { to: "/settings", icon: Settings, label: "Settings", matchPrefix: "/settings", pushToBottom: true },
  { to: "/profile", icon: User, label: "Profile" },
];

interface NavDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function NavDrawer({ open, onClose }: NavDrawerProps) {
  const { pathname } = useLocation();
  const queryClient = useQueryClient();

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  function isItemActive(item: DrawerItem): boolean {
    if (item.matchPrefix) return pathname.startsWith(item.matchPrefix);
    if (item.to === "/") return pathname === "/";
    return pathname.startsWith(item.to);
  }

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 z-[80] animate-[gw-fade_0.18s_ease]"
        style={{ background: "rgba(10,10,8,.42)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" }}
      />

      {/* Drawer panel — matches prototype: var(--gw-drawer) bg, right border, shadow */}
      <div
        role="dialog"
        aria-label="Navigation"
        className="absolute left-0 top-0 z-[81] flex h-full w-[236px] flex-col"
        style={{
          padding: "14px 12px 12px",
          background: "var(--gw-drawer)",
          borderRight: "1px solid rgba(var(--gw-line-rgb),.08)",
          boxShadow: "20px 0 60px rgba(0,0,0,.5)",
          animation: "gw-drawer-in .22s cubic-bezier(.2,.7,.3,1)",
        }}
      >
        {/* Header row: logo + wordmark + close button */}
        <div className="mb-[14px] flex items-center gap-[10px] px-2 py-[2px] pb-1">
          <Logo size={23} className="shrink-0" />
          <span
            className="flex-1 text-[16px] font-semibold leading-none tracking-[-0.01em] text-t1"
            style={{ fontFamily: "'Bricolage Grotesque Variable', system-ui, sans-serif" }}
          >
            Gatewerk
          </span>
          <button
            type="button"
            onClick={onClose}
            title="Collapse menu"
            className="flex h-7 w-7 items-center justify-center rounded-[7px] text-t8 hover:bg-[rgba(var(--gw-line-rgb),0.07)] hover:text-t3"
          >
            <PanelLeft size={16} strokeWidth={1.8} />
          </button>
        </div>

        {/* Nav list */}
        <nav className="flex flex-1 flex-col gap-[2px]">
          {DRAWER_ITEMS.map((item) => {
            const active = isItemActive(item);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={onClose}
                onPointerEnter={() => prefetchRoute(queryClient, item.to)}
                onFocus={() => prefetchRoute(queryClient, item.to)}
                className={[
                  "flex items-center gap-3 rounded-[9px] px-[11px] py-[9px] text-[13.5px] transition-colors",
                  item.pushToBottom ? "mt-auto" : "",
                  active
                    ? "font-semibold text-t1 shadow-[inset_0_1px_0_rgba(var(--gw-line-rgb),0.05)]"
                    : "font-medium text-t6 hover:bg-[rgba(var(--gw-line-rgb),0.06)] hover:text-t3",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={
                  active
                    ? { background: "rgba(var(--gw-line-rgb),.06)" }
                    : undefined
                }
              >
                <Icon size={18} strokeWidth={1.8} className="w-[18px] shrink-0" />
                <span className="flex-1">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}

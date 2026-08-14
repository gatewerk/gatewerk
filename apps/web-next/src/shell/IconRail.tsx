import { lazy, Suspense, useState, type ComponentType } from "react";
import { NavLink, useLocation } from "react-router";
import {
  Inbox,
  Clock,
  SquareStack,
  StickyNote,
  Settings,
  MessageSquare,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ThemeToggle } from "~/theme/ThemeToggle";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isCloud } from "@gatewerk/web-core/lib/cloud-mode";
import { unreadCountQuery } from "~/route-queries";
import { prefetchRoute } from "~/prefetch";
import { ProductFeedbackModalOss } from "~/components/product-feedback/ProductFeedbackModalOss";

// The cast states the props contract src/ expects from the Cloud module.
// Without the ee submodule the wildcard shim types the lazy component as
// LazyExoticComponent<any>, which rejects every prop in JSX, so any
// props-taking Cloud component needs a ComponentType<Props> cast here.
const ProductFeedbackModalCloud = isCloud()
  ? (lazy(() =>
      import("@ee/product-feedback/ProductFeedbackModal").then((m) => ({
        default: m.ProductFeedbackModal,
      })),
    ) as ComponentType<{ onClose: () => void }>)
  : null;

interface RailItem {
  to: string;
  icon: LucideIcon;
  label: string;
  exact?: boolean;
}

const NAV_ITEMS: RailItem[] = [
  { to: "/", icon: Inbox, label: "Inbox", exact: true },
  { to: "/history", icon: Clock, label: "History" },
  { to: "/templates", icon: SquareStack, label: "Templates" },
  { to: "/notes", icon: StickyNote, label: "Notes" },
];

// The active item paints its own chip, instantly.
//
// A sliding shared indicator was tried here — backdrop-filter, then
// translate3d plus will-change, then a plain unpromoted translateY — and on
// one machine the unselected icons kept moving left and snapping
// back on every selection. A vertical slide cannot cause a horizontal shift,
// so the cause was never the animation itself, and it was not worth more
// hunting for a 200ms decoration. The grouped container it lived in was the
// part actually asked for, and that stays.
const ACTIVE_CLS =
  "text-t2 bg-[rgba(var(--gw-line-rgb),0.09)] shadow-[inset_0_0_0_1px_rgba(var(--gw-line-rgb),0.08)]";
const INACTIVE_CLS =
  "text-t8 hover:text-t3 hover:bg-[rgba(var(--gw-line-rgb),0.06)]";
const ITEM_BASE =
  "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] transition-colors";

interface IconRailProps {
  onToggleDrawer: () => void;
}

export function IconRail({ onToggleDrawer }: IconRailProps) {
  const { pathname } = useLocation();
  const [productFeedbackOpen, setProductFeedbackOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: unreadData } = useQuery({ ...unreadCountQuery, refetchInterval: false });
  const unreadBadgeCount = unreadData?.count ?? 0;

  function isActive(item: RailItem): boolean {
    if (item.exact) return pathname === item.to;
    return pathname.startsWith(item.to);
  }

  function isSettingsActive(): boolean {
    return pathname.startsWith("/settings");
  }

  // Clicking anywhere in the rail's empty space
  // opens the drawer — the SAME handler the toggle button already calls, not
  // a second way of doing it. Guarded by walking up from the click target to
  // the nearest <a>/<button> rather than checking `e.target === e.currentTarget`:
  // several genuinely empty parts of this rail (the flex-1 spacer span below,
  // the grouped nav container's own padding/gaps) are themselves elements
  // distinct from this <aside>, so a strict target-equality check would
  // silently ignore clicks that land on them even though they are exactly the
  // "empty space" this is meant to catch. Walking up to the nearest control
  // tells us whether the click landed on something interactive regardless of
  // which non-interactive wrapper happened to receive it.
  //
  // Deliberately no cursor, hover, or tooltip change anywhere in this file to
  // signal the empty space is clickable — nothing about how the rail looks
  // should change. The discoverability cost (a click target with no
  // affordance is easy to miss) is a known, accepted tradeoff; do not "fix"
  // it by adding a hover state.
  //
  // No role/tabindex/aria-label added to the <aside> for this either: it's a
  // mouse convenience layered on a control (the toggle button) that is
  // already keyboard reachable on its own. Making the whole rail focusable
  // would add a meaningless stop in the keyboard order and announce a nav
  // landmark as a button to screen readers.
  function handleRailClick(e: React.MouseEvent<HTMLElement>) {
    if ((e.target as HTMLElement).closest("a, button")) return;
    onToggleDrawer();
  }

  return (
    <>
      <aside
        aria-label="Main navigation"
        onClick={handleRailClick}
        className="flex h-full w-14 shrink-0 flex-col items-center gap-[5px] border-r border-[rgba(var(--gw-line-rgb),0.07)] bg-rail pb-4 pt-[14px]"
      >
        {/* Drawer trigger — 19px panel icon (prototype line 44; the logo mark
            in the prototype rail is display:none) */}
        <button
          type="button"
          onClick={onToggleDrawer}
          aria-label="Toggle navigation drawer"
          title="Toggle navigation"
          className="mb-2 flex h-9 w-9 items-center justify-center rounded-[9px] text-t8 hover:bg-[rgba(var(--gw-line-rgb),0.06)] hover:text-t3"
        >
          <svg
            width="19"
            height="19"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <rect x="3" y="4" width="6.5" height="16" rx="2" fill="currentColor" stroke="none" />
          </svg>
        </button>

        {/* Nav items, grouped inside the app's segmented-control surface.
            The destinations should read as one
            group the way the All / Active / Inactive filter does, rather than
            as four loose icons.

            Values copied from components/SegmentedTabs.tsx:59-61 — padding 3,
            background rgba(var(--gw-hi-rgb),.03), border
            rgba(var(--gw-line-rgb),.08). The radius is the one value NOT copied
            verbatim: SegmentedTabs pairs a 9px shell with 6px pills, so the
            corners stay concentric at inner + padding. This rail's items are
            already 9px (ITEM_BASE), so its shell is 12.

            The drawer trigger above and the theme and settings buttons below
            stay OUTSIDE the group: they are controls, not destinations, and the
            filter this borrows from never wraps its neighbours either. */}
        <div
          className="relative flex flex-col items-center gap-[5px]"
          style={{
            padding: 3,
            borderRadius: 12,
            background: "rgba(var(--gw-hi-rgb),.03)",
            border: "1px solid rgba(var(--gw-line-rgb),.08)",
            boxSizing: "border-box",
          }}
        >
        {NAV_ITEMS.map((item) => {
          const active = isActive(item);
          const Icon = item.icon;
          const showBadge = item.to === "/" && unreadBadgeCount > 0;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              title={item.label}
              className={[ITEM_BASE, active ? ACTIVE_CLS : INACTIVE_CLS].join(
                " ",
              )}
              style={{ position: "relative" }}
              onPointerEnter={() => prefetchRoute(queryClient, item.to)}
              onFocus={() => prefetchRoute(queryClient, item.to)}
            >
              <Icon size={18} strokeWidth={1.8} />
              {showBadge && (
                <span
                  aria-label={`${unreadBadgeCount} unread`}
                  style={{
                    position: "absolute",
                    top: 3,
                    right: 3,
                    minWidth: 14,
                    height: 14,
                    borderRadius: 7,
                    background: "rgba(var(--gw-green-rgb),1)",
                    color: "var(--gw-panel-a)",
                    fontSize: 9,
                    fontWeight: 700,
                    lineHeight: "14px",
                    textAlign: "center",
                    padding: "0 3px",
                    pointerEvents: "none",
                  }}
                >
                  {unreadBadgeCount > 99 ? "99" : unreadBadgeCount}
                </span>
              )}
            </NavLink>
          );
        })}
        </div>

        {/* Spacer pushes theme toggle + settings to bottom */}
        <span className="flex-1" aria-hidden />

        {/* Send feedback */}
        <button
          type="button"
          title="Send feedback"
          aria-label="Send feedback"
          onClick={() => setProductFeedbackOpen(true)}
          className={[ITEM_BASE, INACTIVE_CLS].join(" ")}
        >
          <MessageSquare size={18} strokeWidth={1.8} />
        </button>

        {/* Theme toggle */}
        <ThemeToggle />

        {/* Settings */}
        <NavLink
          to="/settings"
          title="Settings"
          className={[
            ITEM_BASE,
            isSettingsActive() ? ACTIVE_CLS : INACTIVE_CLS,
          ].join(" ")}
          onPointerEnter={() => prefetchRoute(queryClient, "/settings")}
          onFocus={() => prefetchRoute(queryClient, "/settings")}
        >
          <Settings size={18} strokeWidth={1.8} />
        </NavLink>
      </aside>
      {productFeedbackOpen &&
        (ProductFeedbackModalCloud ? (
          <Suspense fallback={null}>
            <ProductFeedbackModalCloud onClose={() => setProductFeedbackOpen(false)} />
          </Suspense>
        ) : (
          <ProductFeedbackModalOss onClose={() => setProductFeedbackOpen(false)} />
        ))}
    </>
  );
}

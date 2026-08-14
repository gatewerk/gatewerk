/**
 * Bottom tab bar, the phone's replacement for IconRail.
 *
 * Four destinations because those are the four screens with a phone layout.
 * Templates is absent on purpose rather than present and disabled: an
 * affordance for a behaviour the reader cannot have is exactly what the app's
 * own rule forbids (see DetailHeader's overflow menu for the same reasoning).
 *
 * Icons and destination order are copied from IconRail.tsx's NAV_ITEMS (with
 * Templates dropped and Settings, which IconRail renders separately at the
 * bottom of the rail, appended last) so the two navigations cannot drift.
 * Notes uses StickyNote, matching IconRail, not FileText.
 */
import { NavLink } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Inbox, Clock, StickyNote, Settings } from "lucide-react";
import { prefetchRoute } from "~/prefetch";

const TABS = [
  { to: "/", label: "Inbox", Icon: Inbox, end: true },
  { to: "/history", label: "History", Icon: Clock, end: false },
  { to: "/notes", label: "Notes", Icon: StickyNote, end: false },
  { to: "/settings", label: "Settings", Icon: Settings, end: false },
] as const;

export function MobileTabBar() {
  const queryClient = useQueryClient();
  return (
    <nav
      className="flex shrink-0 items-stretch"
      style={{
        borderTop: "1px solid rgba(var(--gw-line-rgb),.09)",
        background: "var(--gw-panel-a)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {TABS.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onTouchStart={() => prefetchRoute(queryClient, to)}
          className="flex flex-1 flex-col items-center justify-center gap-1 no-underline"
          style={({ isActive }) => ({
            padding: "9px 0 7px",
            color: isActive ? "var(--gw-t2)" : "var(--gw-t8)",
          })}
        >
          <Icon size={19} strokeWidth={1.9} />
          <span style={{ fontSize: 10.5, fontWeight: 500 }}>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

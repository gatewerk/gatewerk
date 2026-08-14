/**
 * NotFound — catch-all inside the authenticated shell (App.tsx's `path="*"`).
 * Only a signed-in reviewer sees this (a stale link, an old bookmark); a
 * logged-out visitor hits RequireAuth's redirect first. So this renders
 * inside AppShell, with the sidebar already on screen, not a standalone page.
 *
 * Shape matches the app's one empty-state pattern (52px icon tile, 15px
 * title, 13px body — see DetailEmpty.tsx).
 */
import { SearchX } from "lucide-react";
import { Link } from "react-router";
import { EmptyStateTier3 } from "~/components/empty-state";

export function NotFound() {
  return (
    <EmptyStateTier3
      icon={<SearchX size={24} strokeWidth={1.6} />}
      title="Page not found"
      body="That page does not exist, or it may have moved."
    >
      <Link
        to="/"
        className="gw-focus-ring"
        style={{ fontSize: 12.5, fontWeight: 500, color: "var(--gw-blue-t)" }}
      >
        Back to inbox
      </Link>
    </EmptyStateTier3>
  );
}

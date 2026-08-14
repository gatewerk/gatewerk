/**
 * Tier 3 — a detail pane with nothing selected.
 *
 * This is a resting state, not a problem, so it neither pulses nor offers an
 * action. It is the shape named "the app's one
 * empty-state pattern": a 52px tile, a 15px title, a 13px body.
 *
 * Written exception against the onboarding design's README, which defines
 * T3 as "32×32 inset tile + one dim line". Adopting the handoff's smaller shape
 * would reverse the shape used across three screens and buy nothing;
 * unifying the three hand-copies of it — Inbox, History, NotFound — is the part
 * of the handoff's "no per-page forks left" that was actually worth having.
 *
 * `children` is the slot History uses for its ↑/↓ keycap row. That row stays
 * History-only because History is the only screen where arrow browsing is wired,
 * and a hint that advertises behaviour that does not exist is a defect.
 */

import type { ReactNode } from "react";

interface Props {
  icon: ReactNode;
  title: string;
  body: string;
  children?: ReactNode;
}

export function EmptyStateTier3({ icon, title, body, children }: Props) {
  return (
    <div className="grid h-full place-items-center">
      <div
        className="flex flex-col items-center text-center"
        style={{ gap: 16, padding: 24, maxWidth: 280 }}
      >
        <div
          className="flex shrink-0 items-center justify-center"
          style={{
            width: 52,
            height: 52,
            borderRadius: 13,
            background: "rgba(var(--gw-line-rgb),.04)",
            border: "1px solid rgba(var(--gw-line-rgb),.09)",
            color: "var(--gw-t8)",
          }}
        >
          {icon}
        </div>
        <div className="flex flex-col" style={{ gap: 6 }}>
          <p
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 600,
              color: "var(--gw-t4)",
              letterSpacing: "-.005em",
            }}
          >
            {title}
          </p>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--gw-t8)" }}>{body}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

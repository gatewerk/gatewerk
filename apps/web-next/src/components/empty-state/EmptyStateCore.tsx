/**
 * EmptyStateCore — the icon tile, optionally wrapped in the LISTENING rings.
 *
 * ONE implementation, four call sites: the inbox Tier-1 empty state, the cloud
 * wizard's step 3, the invite "entering" handoff, and the reviewer sample's
 * "ready" state. That is the point of it — before this, apps/web had the ring
 * twice (once animated, once not), which is how the two surfaces the design
 * wants to read as continuous ended up looking different.
 *
 * `tone="green"` is the confirmed/ready tile (wizard step 3, invite entering);
 * `tone="neutral"` is the resting inbox glyph. Both take the same rings, which
 * is what makes the wizard dissolve into the inbox without a visual cut.
 */

import type { ReactNode } from "react";

interface Props {
  icon: ReactNode;
  /** "live" adds the two staggered pulse rings. Only where something is genuinely being awaited. */
  ring: "live" | "none";
  size?: 44 | 52;
  tone?: "neutral" | "green";
}

// Half-period stagger: ring two starts as ring one crosses the middle of its
// travel, so the pair reads as one continuous outward breath rather than two.
const RING_DELAYS_MS = [0, 1400];

export function EmptyStateCore({ icon, ring, size = 44, tone = "neutral" }: Props) {
  const green = tone === "green";
  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      {ring === "live" &&
        RING_DELAYS_MS.map((delay) => (
          <span
            key={delay}
            // gw-ring is the hook the reduced-motion block in tokens.css freezes.
            className="gw-ring pointer-events-none absolute inset-0"
            style={{
              borderRadius: 16,
              border: "1.5px solid rgba(var(--gw-green-rgb),.22)",
              animation: `gw-pulse-ring 2800ms ease-out ${delay}ms infinite`,
            }}
          />
        ))}
      <div
        className="flex items-center justify-center"
        style={{
          width: size,
          height: size,
          borderRadius: green ? 16 : 14,
          background: green
            ? "rgba(var(--gw-green-rgb),.12)"
            : "linear-gradient(to bottom, rgba(var(--gw-line-rgb),.07), rgba(var(--gw-line-rgb),.03))",
          border: green
            ? "1px solid rgba(var(--gw-green-rgb),.3)"
            : "1px solid rgba(var(--gw-line-rgb),.13)",
          boxShadow: green ? undefined : "inset 0 1px 0 rgba(var(--gw-line-rgb),.06)",
          // t5, not t8. The board paints this glyph #b4b4ac, which IS t5 on the
          // dark ramp — the same ink as the subtitle under it. At t8 the icon
          // sat two steps into the faint end and the tile read as disabled.
          color: green ? "var(--gw-green-d)" : "var(--gw-t5)",
        }}
      >
        {icon}
      </div>
    </div>
  );
}

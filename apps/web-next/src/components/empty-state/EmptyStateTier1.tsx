/**
 * Tier 1 — first run, or a genuinely empty collection.
 *
 * This tier explains a system that has not started yet, which is why it earns
 * an icon, a title and a next step. **At most one action, ever**: the tier is
 * the hierarchy, and a second action turns an explanation into a menu.
 *
 * The footer is either a status (something is being awaited) or an action
 * (the next move is the reviewer's) — never both, and never neither by accident:
 * Templates T1 takes an action because the user acts next, History T1 takes a
 * quiet status because a person acts next, Inbox T1 takes a live status because
 * a machine acts next.
 */

import type { ReactNode } from "react";
import { EmptyStateCore } from "./EmptyStateCore";
import { StatusPill } from "./StatusPill";

export type Tier1Footer =
  | { kind: "status"; variant: "live" | "quiet"; label: string }
  /**
   * `busy` is not decoration. The only action a Tier-1 state offers is usually a
   * create, and a create button that stays live while its request is in flight
   * takes a second click and makes a second thing. The slot exists so callers
   * cannot forget it.
   */
  | { kind: "action"; label: string; onClick: () => void; busy?: boolean };

interface Props {
  icon: ReactNode;
  ring: "live" | "none";
  title: string;
  subtitle: string;
  footer?: Tier1Footer;
}

export function EmptyStateTier1({ icon, ring, title, subtitle, footer }: Props) {
  // 18px between core, text and footer; 7px inside the text block. Both are
  // the board's, not a rounded Tailwind step — at gap-4/gap-1.5 the stack sat
  // a little tighter than the frames it is meant to reproduce.
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center px-[34px] py-10 text-center animate-[gw-fade_.3s_ease]"
      style={{ gap: 18 }}
    >
      <EmptyStateCore icon={icon} ring={ring} />

      <div className="flex flex-col" style={{ gap: 7 }}>
        <div
          className="font-display text-[16px] font-semibold text-t1"
          style={{ letterSpacing: "-.01em" }}
        >
          {title}
        </div>
        {/* 12.5px/1.5 — T1 subtitles are 12.5 everywhere (empty-state board).
            The faint end of the ramp is gated by token-contrast.test.ts; this
            is real information, so it does not go below t5.

            maxWidth is the board's measure. Without it the subtitle runs the
            full width of the list column and breaks in a different place than
            every frame the design was signed off on. */}
        <div className="text-[12.5px] text-t5" style={{ lineHeight: 1.5, maxWidth: 238 }}>
          {subtitle}
        </div>
      </div>

      {footer?.kind === "status" && (
        <StatusPill variant={footer.variant} label={footer.label} />
      )}
      {footer?.kind === "action" && (
        <button
          type="button"
          onClick={footer.onClick}
          disabled={footer.busy}
          aria-busy={footer.busy}
          className="gw-focus-ring mt-1 rounded-[9px] border-none px-4 py-[7px] text-[12px] font-semibold transition-opacity hover:opacity-90"
          style={{
            background: "var(--gw-green)",
            color: "var(--gw-green-ink)",
            opacity: footer.busy ? 0.5 : 1,
            cursor: footer.busy ? "wait" : "pointer",
          }}
        >
          {footer.label}
        </button>
      )}
    </div>
  );
}

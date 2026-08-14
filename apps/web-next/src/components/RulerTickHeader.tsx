/**
 * RulerTickHeader — the section header, everywhere.
 *
 * Mono uppercase label (10.5px/600, .16em tracking, --gw-t7 — t8 read sub-AA for a label that names the section) + a hairline rule
 * that fills the row + an optional right slot + a short vertical end tick.
 *
 * THE TICK IS NOW THE DEFAULT. It used to be
 * opt-in, off, with the reasoning that "the tick is a per-screen decision" —
 * History carried it and the Inbox did not, so the same header rendered two
 * ways in one product depending on which screen you were standing on. A ruler
 * ends in a mark, not in thin air, and it does so on every screen.
 *
 * The one real distinction survives, and it is a distinction between KINDS of
 * header rather than between screens: a right rail is a narrow column of short
 * blocks, and a tick every 90px reads as tally marks. Rails pass
 * `endTick={false}` — the Inbox's four rail sections, History's Details, and
 * the template editor's Activity.
 *
 * The right slot sits BEFORE the tick, which is where History's own list-bucket
 * header puts its count (History.tsx). The tick terminates the row, not the
 * rule.
 *
 * Moved here from screens/inbox/detail/ because three screens use it and two of
 * them were reaching across a feature boundary to import it.
 */
import type { ReactNode } from "react";

interface Props {
  label: string;
  /** Wrapper margin override — main-column default "mb-4" (the column gap
   *  separates sections); rails and grid children pass their own. */
  marginClassName?: string;
  /** Off for right rails only. See the note above. */
  endTick?: boolean;
  /** A count, a link, a disclosure — sits between the rule and the tick. */
  right?: ReactNode;
}

export function RulerTickHeader({
  label,
  marginClassName = "mb-4",
  endTick = true,
  right,
}: Props) {
  return (
    <div className={`${marginClassName} flex items-center gap-3`}>
      <span
        className="shrink-0 font-mono text-[10.5px] font-semibold uppercase"
        style={{ color: "var(--gw-t7)", letterSpacing: ".16em" }}
      >
        {label}
      </span>
      <div
        className="min-w-0 flex-1"
        style={{ height: 1, background: "rgba(var(--gw-line-rgb),.07)" }}
      />
      {right}
      {endTick && (
        <span
          aria-hidden
          className="shrink-0"
          style={{ width: 1, height: 6, background: "rgba(var(--gw-line-rgb),.13)" }}
        />
      )}
    </div>
  );
}

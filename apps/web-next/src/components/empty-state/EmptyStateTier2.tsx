/**
 * Tier 2 — a filter or a search excluded everything; the underlying list is not
 * empty.
 *
 * **No icon. Ever.** This is a dead end the reviewer created, so the data does
 * exist and an icon would imply an emptiness that is not real. The only useful
 * content is the way back, which is why there is exactly one reset link and it
 * is the one thing here wearing colour.
 */

import type { ReactNode } from "react";

interface Props {
  title: ReactNode;
  /** One short line of context. Some causes have one, some do not; that asymmetry is deliberate. */
  hint?: string;
  resetLabel: string;
  onReset: () => void;
}

export function EmptyStateTier2({ title, hint, resetLabel, onReset }: Props) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-[34px] py-10 text-center animate-[gw-fade_.3s_ease]">
      <div className="flex flex-col gap-1.5">
        <div className="text-[12.5px] font-medium text-t4">{title}</div>
        {hint && <div className="text-[11.5px] text-t5">{hint}</div>}
      </div>
      <button
        type="button"
        onClick={onReset}
        className="gw-focus-ring cursor-pointer border-none bg-transparent text-[11.5px] font-medium text-green-t transition-opacity hover:opacity-75"
      >
        {resetLabel}
      </button>
    </div>
  );
}

/**
 * The searched term, rendered inside a Tier-2 title. Mono and recoloured rather
 * than quoted — the board sets the term apart by treatment, and adding literal
 * quotes on top reads as part of what was typed.
 */
export function SearchTerm({ q }: { q: string }) {
  const trimmed = q.trim();
  const shown = trimmed.length > 32 ? `${trimmed.slice(0, 32)}…` : trimmed;
  return (
    <span className="font-mono text-t3" style={{ fontSize: "0.95em" }}>
      {shown}
    </span>
  );
}

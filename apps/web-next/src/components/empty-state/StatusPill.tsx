/**
 * StatusPill — the dot and mono label that sits under a Tier-1 empty state.
 *
 * Two variants, and the difference between them is a claim about the world:
 *
 *   live  — LISTENING. Everything is wired and we are genuinely waiting on a
 *           machine. Green, glowing, blinking. This is the only non-action use
 *           of green the onboarding design licenses ("Shared listening
 *           state").
 *   quiet — waiting on a person, not a machine. History's "Waiting for first
 *           decision" gets this: nothing is being received, so nothing may
 *           imply reception.
 *
 * Do not put a live pill on a surface where nothing is actually being listened
 * for. The pill is a status claim, not decoration.
 */

interface Props {
  variant: "live" | "quiet";
  label: string;
}

export function StatusPill({ variant, label }: Props) {
  const live = variant === "live";
  return (
    <div className="mt-1 inline-flex items-center gap-2">
      <span
        // gw-blink is the hook the reduced-motion block in tokens.css freezes.
        className={live ? "gw-blink h-1.5 w-1.5 rounded-full" : "h-1.5 w-1.5 rounded-full"}
        style={{
          background: live ? "var(--gw-green)" : "var(--gw-t10)",
          boxShadow: live ? "0 0 8px 1px rgba(var(--gw-green-rgb),.55)" : undefined,
          animation: live ? "gw-blink 1800ms ease-in-out infinite" : undefined,
        }}
      />
      <span
        className="font-mono text-[10.5px] font-semibold uppercase tracking-[.08em]"
        // green-t, not green: the anchor is a fill colour and reads at 2.25:1
        // as ink on the light page. t8 for quiet keeps the faint end legible
        // (token-contrast.test.ts is the gate).
        style={{ color: live ? "var(--gw-green-t)" : "var(--gw-t8)" }}
      >
        {label}
      </span>
    </div>
  );
}

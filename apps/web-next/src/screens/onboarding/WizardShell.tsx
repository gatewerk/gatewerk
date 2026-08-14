/**
 * The wizard's frame: brand header, step ticks, body, footer.
 *
 * Split out of OnboardingWizard so the three steps stay readable and so the
 * frame's one rule is enforced in one place — the footer always offers a way
 * out. A fresh admin who dismisses onboarding must always have a path back
 * (Settings replays it); a wizard with no exit was the explicit failure of the
 * pre-redesign flow.
 */

import type { ReactNode } from "react";
import { Logo } from "~/shell/Logo";

interface Props {
  step: 0 | 1 | 2;
  children: ReactNode;
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  onSkip: () => void;
}

export function WizardShell({
  step,
  children,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  onSkip,
}: Props) {
  return (
    <div className="grid min-h-screen place-items-center bg-page px-4">
      {/* Ambient glow. Decoration, and the only thing on this screen wearing
          green that is not an action or a status. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(var(--gw-green-rgb),.05) 0%, transparent 55%)",
        }}
      />

      <div
        className="relative w-full animate-[gw-fade_.3s_ease]"
        style={{
          maxWidth: 462,
          borderRadius: 18,
          background: "linear-gradient(180deg, var(--gw-panel-a), var(--gw-panel-b))",
          border: "1px solid rgba(var(--gw-line-rgb),.09)",
          boxShadow: "0 18px 48px rgba(0,0,0,.34), inset 0 1px 0 rgba(var(--gw-line-rgb),.06)",
          padding: 26,
        }}
      >
        {/* Header */}
        <div className="flex items-center" style={{ gap: 12 }}>
          <div
            className="flex shrink-0 items-center justify-center"
            style={{ width: 34, height: 34, borderRadius: 10, overflow: "hidden" }}
          >
            <Logo size={34} />
          </div>
          <div className="flex min-w-0 flex-col" style={{ gap: 2 }}>
            <div
              className="font-display text-[16px] font-semibold text-t1"
              style={{ letterSpacing: "-.01em" }}
            >
              Set up Gatewerk
            </div>
            <div className="font-mono text-[10.5px] font-medium uppercase tracking-[.12em] text-t8">
              Step {step + 1} of 3
            </div>
          </div>
        </div>

        {/* Progress ticks */}
        <div className="flex" style={{ gap: 6, marginTop: 18 }}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                transition: "background-color .25s",
                background:
                  i <= step ? "var(--gw-green)" : "rgba(var(--gw-line-rgb),.10)",
              }}
            />
          ))}
        </div>

        {/* Body — keyed so each step fades in rather than swapping in place */}
        <div key={step} className="animate-[gw-fade_.22s_ease]" style={{ marginTop: 22 }}>
          {children}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between" style={{ marginTop: 26, gap: 12 }}>
          <button
            type="button"
            onClick={onSkip}
            className="gw-focus-ring cursor-pointer rounded-[8px] border-none bg-transparent font-mono text-[11.5px] text-t8 transition-colors hover:text-t5"
            style={{ padding: "6px 8px", marginLeft: -8 }}
          >
            Skip for now
          </button>
          <button
            type="button"
            onClick={onPrimary}
            disabled={primaryDisabled}
            className="gw-focus-ring cursor-pointer rounded-[10px] border-none text-[13px] font-semibold transition-opacity"
            style={{
              background: "var(--gw-green)",
              color: "var(--gw-green-ink)",
              padding: "10px 20px",
              opacity: primaryDisabled ? 0.55 : 1,
              cursor: primaryDisabled ? "not-allowed" : "pointer",
              boxShadow: "0 6px 18px rgba(var(--gw-green-rgb),.18)",
            }}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * ReviewFrame — the public /r/:token shell: page background, ambient glow,
 * 576px column, header (wordmark + "Secure review" chip) and footer.
 * Present in EVERY state, including terminal ones.
 *
 * Spec §1. Design: Gatewerk External Review.dc.html:27-41, 121-125.
 */

import { Lock } from "lucide-react";
import { Logo } from "~/shell/Logo";

export function ReviewFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-x-hidden bg-page font-sans text-t2 antialiased">
      {/* Ambient green glow (bigger and higher than Login's) */}
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            "radial-gradient(680px 420px at 50% -8%, rgba(var(--gw-green-rgb),.10), transparent 70%)",
        }}
      />

      <div
        className="relative mx-auto"
        style={{ maxWidth: 576, padding: "26px 22px 120px" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between"
          style={{ marginBottom: 30 }}
        >
          <div className="flex items-center" style={{ gap: 10 }}>
            <Logo size={24} />
            <span
              className="font-display text-t1"
              style={{ fontSize: 15, fontWeight: 600 }}
            >
              Gatewerk
            </span>
          </div>
          <span
            className="inline-flex items-center font-mono uppercase"
            style={{
              gap: 6,
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: ".06em",
              color: "rgba(var(--gw-green-rgb),.9)",
              background: "rgba(var(--gw-green-rgb),.1)",
              border: "1px solid rgba(var(--gw-green-rgb),.24)",
              borderRadius: 999,
              padding: "4px 10px",
            }}
          >
            <Lock size={11} strokeWidth={2} />
            Secure review
          </span>
        </div>

        <div style={{ animation: "gw-fade .28s ease" }}>{children}</div>

        {/* Footer */}
        <div style={{ marginTop: 40, textAlign: "center" }}>
          <span style={{ fontSize: 11, color: "var(--gw-t10)" }}>
            Powered by <span style={{ color: "var(--gw-t6)" }}>Gatewerk</span> ·
            Human oversight for AI agents
          </span>
        </div>
      </div>
    </div>
  );
}

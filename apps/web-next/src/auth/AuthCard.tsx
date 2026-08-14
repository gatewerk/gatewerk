/**
 * AuthCard — 384px centered card shell used by Login (and future auth pages).
 * Logo mark + heading + sub + green radial glow background.
 * Design: Gatewerk Login.dc.html, README §1.
 */

import { isCloud } from "@gatewerk/web-core/lib/cloud-mode";
import { Logo } from "~/shell/Logo";

interface AuthCardProps {
  title: string;
  sub?: string;
  children: React.ReactNode;
  /**
   * Optional line between the card and the fixed "Gatewerk · Open Source"
   * footer. The cloud sign in and sign up screens cross-link to each other
   * there; the OSS screens pass nothing and render exactly as before.
   */
  footer?: React.ReactNode;
}

export function AuthCard({ title, sub, children, footer }: AuthCardProps) {
  return (
    <div
      style={{ minHeight: "100vh" }}
      className="relative flex flex-col items-center justify-center px-5 pb-10 pt-[5vh] bg-page font-sans antialiased text-t2"
    >
      {/* Green radial ambient glow */}
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            "radial-gradient(560px 380px at 50% 30%, rgba(var(--gw-green-rgb),.07), transparent 60%)",
        }}
      />

      <div
        className="relative w-full"
        style={{
          maxWidth: 384,
          animation: "gw-fade .3s ease",
        }}
      >
        {/* Logo + heading */}
        <div className="mb-9 flex flex-col items-center">
          <div className="relative mb-[18px]">
            {/* Glow halo behind logo */}
            <div
              className="absolute rounded-full"
              style={{
                inset: -14,
                background: "rgba(var(--gw-green-rgb),.1)",
                filter: "blur(20px)",
              }}
            />
            <Logo size={46} className="relative" />
          </div>
          <h1
            className="m-0 font-display text-t1"
            style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}
          >
            {title}
          </h1>
          {sub && (
            <p className="mt-2 text-t8" style={{ fontSize: 13 }}>
              {sub}
            </p>
          )}
        </div>

        {/* Card */}
        <div
          style={{
            borderRadius: 18,
            background: "linear-gradient(180deg,var(--gw-panel-a),var(--gw-panel-b))",
            border: "1px solid rgba(var(--gw-line-rgb),.1)",
            boxShadow:
              "0 24px 60px rgba(0,0,0,.45), inset 0 1px 0 rgba(var(--gw-line-rgb),.05)",
            padding: 26,
          }}
        >
          {children}
        </div>

        {footer && <div style={{ marginTop: 22 }}>{footer}</div>}
      </div>

      {/* Footer — standalone only.
          "Gatewerk · Open Source" is the self-host signature. On
          app.gatewerk.com it describes the wrong thing: the person signing in
          is buying a managed service, and the line sat directly under a paid
          signup CTA. Dropping it entirely rather than trimming it to
          "Gatewerk" — the heading two inches above already says Gatewerk, and
          silence is the default (chrome doctrine, rule 3). */}
      {!isCloud() && (
        <p className="relative mt-9 font-mono text-t11" style={{ fontSize: 10.5 }}>
          Gatewerk · Open Source
        </p>
      )}
    </div>
  );
}

/**
 * The invite page's left panel: who we are and what is being asked.
 *
 * Static across all three phases, on purpose. Most people opening this link
 * have never been asked to oversee an agent and have no idea what they are
 * agreeing to; the panel answers that once and then stops moving while the
 * right-hand column changes underneath it.
 */

import { Inbox, PenLine, Check, Lock } from "lucide-react";
import { Logo } from "~/shell/Logo";
import { INVITE_COPY as C } from "./auth-copy";

const POINT_ICONS = [Inbox, PenLine, Check];

export function InviteBrandPanel() {
  return (
    <div
      className="flex flex-col"
      style={{
        width: 372,
        flexShrink: 0,
        padding: "34px 34px 28px",
        background: "linear-gradient(180deg, var(--gw-panel-a), var(--gw-rail))",
        borderRight: "1px solid rgba(var(--gw-line-rgb),.07)",
      }}
    >
      <div className="flex items-center" style={{ gap: 10 }}>
        <Logo size={30} />
        <span
          className="font-display text-[16px] font-semibold text-t1"
          style={{ letterSpacing: "-.01em" }}
        >
          Gatewerk
        </span>
      </div>

      <div style={{ marginTop: 46 }}>
        <div className="font-mono text-[10.5px] font-medium uppercase tracking-[.14em] text-t8">
          {C.brandEyebrow}
        </div>
        <h1
          className="font-display font-semibold text-t1"
          style={{ margin: "12px 0 0", fontSize: 25, lineHeight: 1.24, letterSpacing: "-.02em" }}
        >
          {C.brandHeadline}
        </h1>
      </div>

      <ul style={{ listStyle: "none", margin: "30px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 16 }}>
        {C.brandPoints.map((point, i) => {
          const Icon = POINT_ICONS[i] ?? Check;
          return (
            <li key={point} className="flex items-start" style={{ gap: 12 }}>
              <span
                className="flex shrink-0 items-center justify-center"
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 8,
                  background: "rgba(var(--gw-line-rgb),.05)",
                  border: "1px solid rgba(var(--gw-line-rgb),.09)",
                  color: "var(--gw-t7)",
                  marginTop: 1,
                }}
              >
                <Icon size={13} strokeWidth={1.6} />
              </span>
              <span className="text-[12.5px] text-t5" style={{ lineHeight: 1.5 }}>
                {point}
              </span>
            </li>
          );
        })}
      </ul>

      <div
        className="flex items-center text-[11.5px] text-t8"
        style={{ gap: 7, marginTop: "auto", paddingTop: 32 }}
      >
        <Lock size={12} strokeWidth={1.7} />
        {C.brandFooter}
      </div>
    </div>
  );
}

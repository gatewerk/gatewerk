/**
 * Settings — sub-nav shell with URL-driven active section, in the Redesign
 * prototype's grammar (manifest §2.0) with a merged IA:
 * FOUR pages, not ten.
 *
 * - Account absorbs Notifications, Integrations and Shortcuts (personal
 *   preferences, one door).
 * - Project hosts its rows plus the full-width API Keys | Webhooks pair —
 *   the in and out of the same connection surface, in the template page's
 *   fields | actions grammar.
 * - Activity hosts both logs behind segmented tabs (Activity | Deliveries).
 * - Security stands alone.
 *
 * Legacy section URLs stay alive: they map to their new home on first render
 * (sectionFromPath) and an effect canonicalizes the address, so bookmarks and
 * muscle memory keep working.
 */
import { lazy, Suspense, useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { Activity as ActivityIcon, ChevronRight, CreditCard, Folder, Shield, User } from "lucide-react";
import { isCloud } from "@gatewerk/web-core/lib/cloud-mode";
import { useNarrowViewport } from "~/shell/use-narrow-viewport";
import { MobilePane } from "../mobile/MobilePane";
import { AccountPane } from "./account/AccountPane";
import { ProjectPane } from "./project/ProjectPane";
import { ActivityPane } from "./activity/ActivityPane";
import { SecurityPane } from "./security/SecurityPane";

const BillingPane = isCloud()
  ? lazy(() => import("@ee/billing/BillingPane").then((m) => ({ default: m.BillingPane })))
  : null;

export type SettingsSection = "account" | "project" | "activity" | "security" | "billing";

// Billing is cloud-only: a self-hosted install has no subscription to manage,
// so the section is absent rather than empty. sectionFromPath consults this
// list, so /settings/billing resolves to account in a standalone build.
const SECTIONS: SettingsSection[] = [
  "account",
  "project",
  "activity",
  "security",
  ...(isCloud() ? ["billing" as const] : []),
];

/** Where each retired section's content lives now. Exported for tests. */
export const LEGACY_SECTIONS: Record<string, SettingsSection> = {
  "api-keys": "project",
  webhooks: "project",
  deliveries: "activity",
  notifications: "account",
  integrations: "account",
  shortcuts: "account",
};

/** Pane measure (manifest S0.10, adapted to the merged IA): ONE width for
 *  every section, 1080, matching Project's own pane. The five panes used to
 *  carry five different widths chosen one pane at a time (account 640,
 *  project 1080, activity 860, security 640, billing 640), which read as
 *  inconsistency rather than intent. Billing had briefly been walked back
 *  from 1080 to 640 because its lone card sat against the left edge of a
 *  container twice its width — but narrowing the pane was patching the
 *  symptom. The actual fix, applied everywhere now, is what Project already
 *  did at ProjectPane.tsx:224: give the wide container a grid so its cards
 *  flow to fill it, and cap only the narrow, form shaped content inside at a
 *  readable width (ProjectPane.tsx:147). */
const PANE_WIDTH = 1080;

/** Pure function: derive the active section from the current pathname.
 *  Legacy segments resolve to their new home. Exported for unit tests. */
export function sectionFromPath(pathname: string): SettingsSection {
  const seg = pathname.replace(/^\/settings\/?/, "").split("/")[0];
  if ((SECTIONS as string[]).includes(seg)) return seg as SettingsSection;
  if (seg in LEGACY_SECTIONS) return LEGACY_SECTIONS[seg];
  return "account";
}

/**
 * The Settings sections with a phone layout. Primitive settings on
 * mobile means who am I, my password and my 2FA, and a
 * way out. Everything else is desk work and renders DeskOnly instead.
 *
 * Security is on the list on purpose. It is the one pane a person genuinely
 * needs when they are not at their desk, because it is where a locked out
 * user changes their password.
 */
export const MOBILE_SETTINGS_SECTIONS = ["account", "security"] as const;

export function isMobileSettingsSection(section: string): boolean {
  return (MOBILE_SETTINGS_SECTIONS as readonly string[]).includes(section);
}

const ICON_PROPS = { size: 17, strokeWidth: 1.7, className: "shrink-0" } as const;

const NAV_ITEMS = [
  { key: "account" as const, icon: <User {...ICON_PROPS} />, label: "Account" },
  { key: "project" as const, icon: <Folder {...ICON_PROPS} />, label: "Project" },
  { key: "activity" as const, icon: <ActivityIcon {...ICON_PROPS} />, label: "Activity" },
  { key: "security" as const, icon: <Shield {...ICON_PROPS} />, label: "Security" },
  ...(isCloud()
    ? [{ key: "billing" as const, icon: <CreditCard {...ICON_PROPS} />, label: "Billing" }]
    : []),
] satisfies { key: SettingsSection; icon: React.ReactNode; label: string }[];

const PANES: Record<SettingsSection, React.ReactNode> = {
  account: <AccountPane />,
  project: <ProjectPane />,
  activity: <ActivityPane />,
  security: <SecurityPane />,
  billing: BillingPane ? (
    <Suspense fallback={null}>
      <BillingPane />
    </Suspense>
  ) : null,
};

export function Settings() {
  const location = useLocation();
  const navigate = useNavigate();
  const narrow = useNarrowViewport();

  const selected = sectionFromPath(location.pathname);

  // Canonicalize legacy URLs (the pane already renders correctly on first
  // paint via sectionFromPath; this just fixes the address bar, carrying
  // /settings/deliveries into the Deliveries tab).
  useEffect(() => {
    const seg = location.pathname.replace(/^\/settings\/?/, "").split("/")[0];
    if (!(seg in LEGACY_SECTIONS)) return;
    const target = LEGACY_SECTIONS[seg];
    const suffix = seg === "deliveries" ? "?tab=deliveries" : "";
    navigate(`/settings/${target}${suffix}`, { replace: true });
  }, [location.pathname, navigate]);

  function setSelected(section: SettingsSection) {
    navigate(`/settings/${section}`, { replace: false });
  }

  useEffect(() => {
    document.title = "Settings";
  }, []);

  // Phone layout: a menu (Account, Security, and a note that the rest needs
  // a laptop) at /settings itself, or the one allowed pane full screen once
  // a section is named in the path. isMobileSettingsSection gates both which
  // sections get a live row below and which pathname takes the pane branch,
  // so the two lists can never drift apart. A wide viewport falls straight
  // through to the two column render below, byte for byte unchanged.
  if (narrow) {
    const rawSeg = location.pathname.replace(/^\/settings\/?/, "").split("/")[0];
    const showPane = rawSeg !== "" && isMobileSettingsSection(selected);

    if (showPane) {
      const label = NAV_ITEMS.find((item) => item.key === selected)?.label ?? "Settings";
      return (
        <MobilePane title={label} onBack={() => navigate("/settings")}>
          <div style={{ padding: "18px 16px 40px" }}>{PANES[selected]}</div>
        </MobilePane>
      );
    }

    return (
      <div className="flex h-full flex-col overflow-y-auto" style={{ padding: "18px 14px" }}>
        <span
          className="font-mono text-[10px] font-semibold uppercase"
          style={{ letterSpacing: ".16em", color: "var(--gw-t8)", padding: "0 6px 12px" }}
        >
          Settings
        </span>
        {NAV_ITEMS.filter((item) => isMobileSettingsSection(item.key)).map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => navigate(`/settings/${item.key}`)}
            className="gw-focus-ring flex w-full cursor-pointer items-center gap-3 rounded-[9px] border-none bg-transparent text-left"
            style={{ padding: "13px 10px", color: "var(--gw-t2)" }}
          >
            {item.icon}
            <span className="min-w-0 flex-1 text-[14px] font-medium">{item.label}</span>
            <ChevronRight size={16} strokeWidth={1.7} style={{ color: "var(--gw-t9)" }} />
          </button>
        ))}
        <p className="text-t8" style={{ fontSize: 12, lineHeight: 1.5, padding: "10px 10px 0" }}>
          More settings are available on a laptop.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0">
      {/* ── Sub-nav ── manifest S0.2-S0.8 */}
      <div
        className="flex h-full shrink-0 flex-col gap-0.5 overflow-y-auto"
        style={{
          width: "clamp(190px, 17vw, 224px)",
          padding: "16px 10px",
          borderRight: "1px solid rgba(var(--gw-line-rgb),.06)",
        }}
      >
        <span
          className="font-mono text-[10px] font-semibold uppercase"
          style={{
            letterSpacing: ".16em",
            color: "var(--gw-t8)",
            // Rail alignment measured via real
            // getBoundingClientRect/Range glyph rects at 1440px, not style
            // declarations — the box a text element occupies is not its
            // optical centre, and comparing box centers leaves the label
            // visibly high.
            //
            // Two independent deltas, from the actual glyph and icon ink:
            // - Toggle button icon (shell/IconRail.tsx) center: y=32.
            //   This eyebrow's own glyph ink measured center: y=29.5 — 2.5px
            //   high. padding-top raised 6 -> 8.5 to push the glyph down
            //   2.5px inside its own box, leaving the box's total height (and
            //   so everything below it) untouched: padding-bottom stays 10.
            // - Rail's first icon (Inbox) center: y=84. This list's first
            //   button center measured y=85.75 — 1.75px LOW, despite tops
            //   matching at 67px, because the button's own content (9px
            //   padding + a 13px row) is 3.5px taller than the rail's fixed
            //   34px icon box, so equal tops do not mean equal centers.
            //   marginBottom lowered 18 -> 13.75 (verified empirically post
            //   -change, not just computed: the padding-top raise above also
            //   grows the eyebrow's own box by more than arithmetic alone
            //   predicted, likely subpixel line-height rounding, so the
            //   first pass at 15.75 still measured 2px low and got corrected
            //   against a live getBoundingClientRect readout) to land the
            //   first row's center back on the rail icon's exactly. Same
            //   fixed 39px item rhythm either side — only the block's start
            //   position moved, not its shape.
            padding: "8.5px 12px 10px",
            marginBottom: 13.75,
          }}
        >
          Settings
        </span>
        {NAV_ITEMS.map((item) => {
          const isActive = selected === item.key;
          return (
            <button
              key={item.key}
              onClick={() => setSelected(item.key)}
              className="gw-focus-ring flex w-full cursor-pointer items-center gap-[11px] rounded-[9px] border-none text-left text-[13px] transition-colors duration-150"
              style={{
                padding: "9px 12px",
                fontWeight: isActive ? 600 : 500,
                color: isActive ? "var(--gw-t1)" : "var(--gw-t6)",
                background: isActive ? "rgba(var(--gw-line-rgb),.06)" : "transparent",
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--gw-t4)";
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(var(--gw-line-rgb),.03)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--gw-t6)";
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }
              }}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </div>

      {/* ── Content column ── the shell owns the pane container; panes render
          content only. */}
      <div className="min-w-0 flex-1 overflow-y-auto" style={{ padding: "34px 40px 60px" }}>
        <div className="mx-auto flex flex-col gap-[26px]" style={{ maxWidth: PANE_WIDTH }}>
          {PANES[selected]}
        </div>
      </div>
    </div>
  );
}

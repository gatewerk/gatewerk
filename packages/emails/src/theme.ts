import type { CSSProperties } from "react";

/**
 * Baked theme values for email.
 *
 * Email cannot use CSS custom properties: Gmail strips <style> blocks in
 * several contexts, and an inline var() has no declaration to resolve
 * against. So every value below is the LITERAL light-theme value of the
 * matching token in apps/web-next/src/theme/tokens.css (html.gw-light).
 *
 * The names stay token-shaped on purpose. When a token moves, the value to
 * update here is obvious, and a reader can see that these are not arbitrary
 * hues.
 *
 * Light is the only variant, and deliberately so: a recipient cannot be
 * theme-detected, dark email renders badly in light clients, and the warm
 * cream light theme is the product default.
 */
export const email = {
  /** --gw-page — the area outside the card */
  page: "#efece3",
  /** --gw-panel-a — the card itself */
  card: "#fbfaf6",
  /** --gw-panel-b — the footer band; a tonal step, used instead of a rule */
  band: "#f4f1e9",
  /** --gw-t1 — title ink */
  t1: "#232019",
  /** --gw-t4 — body ink */
  t4: "#565143",
  /** --gw-t7 — muted, footer reason */
  t7: "#8b8474",
  /** --gw-t9 — faint, footer identity */
  t9: "#a49c88",
  /** rgba(var(--gw-line-rgb),.14) — neutral list edge */
  line: "rgba(60,52,34,.14)",
  /** --gw-inset — the code block fill */
  inset: "rgba(74,64,40,.05)",
  /** --gw-green — the brand green, identical in both themes */
  green: "#21b571",
  /** Ink on brand green. Theme-invariant, same literal the /r page keeps. */
  onGreen: "#0a1a11",
  /** --gw-red-t — needs attention, destructive */
  red: "#b0402f",
  /** --gw-amber-t — needs attention, deadline */
  amber: "#8a6212",
} as const;

/**
 * Hanken Grotesk and Bricolage Grotesque cannot ship in email: Gmail strips
 * @font-face, and a webfont <link> resolves in only a minority of clients,
 * which is worse than resolving consistently. Brand is carried here by mark,
 * colour, layout and copy instead.
 *
 * `Inter` is deliberately absent. It is not installed on a typical recipient
 * machine, so naming it only made the source read generic while the render
 * fell through to the system font anyway.
 */
export const fontSans =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** Used in exactly one place, the OTP code, where digit disambiguation earns it. */
export const fontMono =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/**
 * The §3 type scale, shared so the eight body templates cannot each drift.
 * Proportions follow the /r page: title 20/700, body 14/1.6, meta 13.
 */
export const text: Record<"title" | "body" | "meta", CSSProperties> = {
  title: {
    fontSize: "20px",
    fontWeight: "700",
    lineHeight: "1.3",
    color: email.t1,
    margin: "0 0 12px",
  },
  body: {
    fontSize: "14px",
    lineHeight: "1.6",
    color: email.t4,
    margin: "0 0 16px",
  },
  meta: {
    fontSize: "13px",
    lineHeight: "1.5",
    color: email.t7,
    margin: "0",
  },
};

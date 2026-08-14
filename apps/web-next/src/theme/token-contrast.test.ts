/**
 * Readability gate — parses tokens.css and asserts WCAG contrast invariants.
 *
 * This is a read-first app. Light mode must not
 * trade readability for warmth. These assertions encode the bands each ramp
 * step is USED at, so a future palette
 * edit that silently drops a step below its band fails here instead of
 * shipping:
 *
 *   t1–t7  — carry text at 11–14px somewhere in the app → AA normal (4.5:1)
 *   t8     — small de-emphasis text/icons → large-text/UI band (3:1)
 *   t9–t11 — decorative faint end, deliberately sub-AA → unconstrained
 *   green-t / red-t / amber-t / blue-t — status/action TEXT tints → 4.5:1
 *
 * Checked against BOTH the page and panel-a surfaces, in BOTH themes. The
 * brand anchor --gw-green is exempt: it is a FILL color (buttons carry
 * --gw-green-ink on top of it); text sites must use --gw-green-t instead.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(__dirname, "tokens.css"), "utf8");

// Split the sheet into the dark (:root) and light (html.gw-light) blocks and
// read simple `--name:#hex` declarations from each.
function block(startMarker: string): Record<string, string> {
  const start = css.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  const body = css.slice(start, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--gw-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

const dark = block(":root {");
const light = block("html.gw-light {");

function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES: Array<[string, Record<string, string>]> = [
  ["dark", dark],
  ["light", light],
];

// Both real text surfaces. panel-a is the lighter (light theme) / brighter
// (dark theme) card surface, page the base — text renders on both.
const SURFACES = ["--gw-page", "--gw-panel-a"] as const;

describe.each(THEMES)("%s theme", (_name, t) => {
  const surfaces = SURFACES.map((s) => t[s]);

  it("defines every token the gate reads", () => {
    for (const key of ["--gw-page", "--gw-panel-a", "--gw-t1", "--gw-t7", "--gw-t8", "--gw-green-t", "--gw-red-t", "--gw-amber-t", "--gw-blue-t"]) {
      expect(t[key], `${key} missing`).toBeTruthy();
    }
  });

  it.each(["t1", "t2", "t3", "t4", "t5", "t6", "t7"])(
    "%s clears AA normal (4.5:1) on both surfaces",
    (step) => {
      for (const bg of surfaces) {
        expect(ratio(t[`--gw-${step}`], bg)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("t8 clears the large-text/UI band (3:1) on both surfaces", () => {
    for (const bg of surfaces) {
      expect(ratio(t["--gw-t8"], bg)).toBeGreaterThanOrEqual(3.0);
    }
  });

  if (_name === "light") {
    // Read-first floors ("maximum readability"):
    // in light mode even the de-emphasis steps stay legible. Dark keeps the
    // handoff's faint end, so these floors are light-only.
    it("light faint end stays legible: t8>=4.4, t9>=3.7, t10>=2.8, t11>=2.2 vs page", () => {
      const page = t["--gw-page"];
      expect(ratio(t["--gw-t8"], page)).toBeGreaterThanOrEqual(4.4);
      expect(ratio(t["--gw-t9"], page)).toBeGreaterThanOrEqual(3.7);
      expect(ratio(t["--gw-t10"], page)).toBeGreaterThanOrEqual(2.8);
      expect(ratio(t["--gw-t11"], page)).toBeGreaterThanOrEqual(2.2);
    });
  }

  it.each(["green-t", "red-t", "amber-t", "blue-t"])(
    "%s status text tint clears AA normal (4.5:1) on both surfaces",
    (tint) => {
      for (const bg of surfaces) {
        expect(ratio(t[`--gw-${tint}`], bg)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("keeps the text ramp monotonic: t1 strongest, fading toward t11", () => {
    const page = t["--gw-page"];
    const ratios = Array.from({ length: 11 }, (_, i) => ratio(t[`--gw-t${i + 1}`], page));
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i], `t${i + 1} should be fainter than t${i}`).toBeLessThanOrEqual(ratios[i - 1]);
    }
  });
});

// The dark values are the shipped design, verbatim from the design handoff.
// This gate must never force them to change: assert the dark ramp passes
// as-is, so a failure can only ever indict an edit, not the baseline.
it("dark brand green stays the fill anchor and green-t matches it exactly", () => {
  expect(dark["--gw-green-t"]).toBe(dark["--gw-green"]);
});

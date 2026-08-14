#!/usr/bin/env node
/**
 * Print every axis the product declares but does NOT ship at launch.
 *
 * Why this exists as its own command.
 *
 * `pnpm audit:surface` reads `packages/shared/src/**`, the OpenAPI snapshot and
 * `apps/api/src/**`. It never opens either frontend. So a control built for a
 * roadmap or inert axis passes the gate silently, forever — the gate constrains
 * the BACKEND axis inventory, not the UI.
 *
 * That is not hypothetical. `apps/web/src/pages/templates/detail/DetailEditConfig.tsx`
 * renders five roadmap-tier controls today (autoApprove, changesTimeoutHours,
 * defaultAuthLevel, defaultExpirySeconds, allowMonitoring) and the gate has
 * passed the whole time. Nobody was being careless; there was simply nothing
 * that could catch it.
 *
 * So the check has to be done by hand, per screen — and a by-hand check needs
 * an authoritative list that cannot drift. This derives one from the
 * declarations themselves rather than restating them in a doc.
 *
 * Note the UI spells these in camelCase while the declarations use the API's
 * snake_case, so `--camel` prints both. Searching a .tsx file for `auto_approve`
 * returns nothing and looks like a clean bill of health. It is not one.
 *
 *   pnpm surface:held                    # grouped by subsystem
 *   pnpm surface:held --camel            # + the camelCase spelling to grep for
 *   pnpm surface:held --grep template    # word-bounded regex for one screen sweep
 *
 * The sweep is a starting point, not a verdict. It answers "does this file
 * mention a held axis", which is not the same as "does this screen render a
 * control for it" — a prop can be threaded through and never used. Read the
 * hits. The judgement is still yours.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sharedBase = join(here, "..", "packages", "shared", "src");

async function loadDeclarations() {
  // MUST run under bun, exactly as `pnpm audit:surface` does. The declarations
  // are .ts importing sibling modules extensionlessly (`./types`), which bun
  // resolves natively and plain node does not. Use `pnpm surface:held`.
  const specifier = join(sharedBase, "surface-tiers", "index.ts");
  try {
    return await import(specifier);
  } catch (err) {
    console.error(
      "held-axes: could not load packages/shared/src/surface-tiers/index.ts.\n" +
      "Run it with bun — `pnpm surface:held` — not plain node.\n" +
      "Failing loudly rather than printing an empty list: an empty list reads\n" +
      "as 'nothing is held', which is the opposite of the truth.\n",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
}

const snakeToCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

const mod = await loadDeclarations();
if (typeof mod.allDeclaredAxes !== "function") {
  console.error("held-axes: surface-tiers loaded but allDeclaredAxes is missing.");
  process.exit(1);
}

const held = mod
  .allDeclaredAxes()
  .filter(({ declaration }) => declaration.tier === "roadmap" || declaration.tier === "inert");

const grepAt = process.argv.indexOf("--grep");
if (grepAt !== -1) {
  // A regex alternation for sweeping ONE screen, in both spellings.
  //
  // Subsystem-scoped on purpose. An unscoped alternation is actively harmful:
  // axis names repeat across subsystems, so `description` (held on one) flags a
  // template's `description` (tier advanced, legitimately shipped), and generic
  // names like `style` and `order` match a JSX style attribute and the middle of
  // "border". A sweep that cries wolf gets ignored, and then it is worse than
  // no sweep at all.
  const subsystem = process.argv[grepAt + 1];
  const known = [...new Set(held.map((h) => h.subsystem))].sort();
  if (!subsystem || subsystem.startsWith("--")) {
    console.error(
      "held-axes --grep needs a subsystem, because axis names repeat across them.\n" +
      `  known: ${known.join(", ")}\n` +
      "  e.g.  pnpm surface:held --grep template\n",
    );
    process.exit(1);
  }
  const scoped = held.filter((h) => h.subsystem === subsystem);
  if (scoped.length === 0) {
    console.error(`held-axes: no held axes for "${subsystem}". Known: ${known.join(", ")}`);
    process.exit(1);
  }
  const names = new Set();
  for (const { axis } of scoped) {
    names.add(axis);
    names.add(snakeToCamel(axis));
  }
  // Word-bounded so "order" cannot match inside "border".
  console.log(`\\b(${[...names].sort().join("|")})\\b`);
  process.exit(0);
}

const wantCamel = process.argv.includes("--camel");
const bySubsystem = new Map();
for (const entry of held) {
  if (!bySubsystem.has(entry.subsystem)) bySubsystem.set(entry.subsystem, []);
  bySubsystem.get(entry.subsystem).push(entry);
}

let roadmap = 0;
let inert = 0;
for (const [subsystem, entries] of [...bySubsystem].sort()) {
  console.log(`\n── ${subsystem} (${entries.length})`);
  for (const { axis, declaration } of entries.sort((a, b) => a.axis.localeCompare(b.axis))) {
    declaration.tier === "roadmap" ? roadmap++ : inert++;
    const camel = wantCamel && snakeToCamel(axis) !== axis ? `  ui: ${snakeToCamel(axis)}` : "";
    console.log(`   ${declaration.tier.padEnd(7)} ${axis}${camel}`);
  }
}

console.log(
  `\nHELD TOTAL: ${held.length}  (${roadmap} roadmap, ${inert} inert)\n` +
  `None of these may have a control on a launch screen.\n` +
  `audit:surface cannot check this — it never reads the frontend.`,
);

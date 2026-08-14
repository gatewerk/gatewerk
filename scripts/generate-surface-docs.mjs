#!/usr/bin/env node
/**
 * generate-surface-docs — everything downstream of the surface declaration.
 *
 * Emits:
 *   The surface-ratification list. Every
 *     axis, its recommended tier, one line each, so disagreeing is cheap.
 *     Generated (and gitignored) because it must never drift from the source.
 *   site/src/lib/roadmap-data.json — the public roadmap, derived from the
 *     `roadmap` tier. COMMITTED, because the site builds separately from this
 *     workspace. `scripts/audit-surface.mjs` fails if it goes stale.
 *
 * Why generate the public list at all: the site currently documents chains and
 * ladders as complete, and the ladder page claims template-level escalation
 * ladders exist. They exist in no schema anywhere. A generated list cannot make
 * that claim, because there is nothing to generate it from.
 *
 * Run via `pnpm surface:docs`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const {
  SURFACE_TIER_TABLES,
  OUT_OF_SCOPE,
  allDeclaredAxes,
  controlGroupsOn,
  publicRoadmap,
  TEMPLATE_EDITOR_GROUP_BUDGET,
  ACTION_FIELD_BUDGET,
} = await import(join(REPO_ROOT, "packages", "shared", "src", "surface-tiers", "index.ts"));

// ---------------------------------------------------------------------------
// The public roadmap payload (committed, consumed by site/src/pages/roadmap.astro)
// ---------------------------------------------------------------------------

export function buildRoadmapPayload() {
  const lines = publicRoadmap();
  return {
    _comment:
      "GENERATED from packages/shared/src/surface-tiers/ by scripts/generate-surface-docs.mjs. Do not edit by hand — run `pnpm surface:docs`. Every entry is a capability that exists (or is planned) and is deliberately absent from the launch UI.",
    built_and_held: lines
      .filter((l) => l.built)
      .map((l) => ({ feature: l.feature, axes: l.axes })),
    not_started: lines
      .filter((l) => !l.built)
      .map((l) => ({ feature: l.feature, axes: l.axes })),
  };
}

// ---------------------------------------------------------------------------
// The ratification list
// ---------------------------------------------------------------------------

const TIER_ORDER = ["core", "advanced", "roadmap", "request", "inert"];

const TIER_BLURB = {
  core: "in the launch UI",
  advanced: "in the launch UI, behind a disclosure",
  roadmap: "works over the API, absent from the UI, named publicly",
  request: "a per-request input; never a configuration control",
  inert: "settable, persisted, and does nothing; neither surfaced nor promised",
};

function buildRatificationMarkdown() {
  const axes = allDeclaredAxes();
  const L = [];
  const p = (s = "") => L.push(s);

  p("# Surface tiering — ratification list");
  p();
  p("> **GENERATED** from `packages/shared/src/surface-tiers/`. Regenerate with `pnpm surface:docs`.");
  p("> Tiers are proposals; override any line — each is a one-line change in that file.");
  p();
  p("## How to read this");
  p();
  p("The ruling being implemented: the launch version is the fundamental engine, minimised as far as rationally");
  p("possible while still useful on day one. Everything else goes on the roadmap. **Hide, never delete.**");
  p();
  for (const t of TIER_ORDER) p(`- **${t}** — ${TIER_BLURB[t]}`);
  p();
  p("Nothing in this list changes runtime behaviour. Every axis still validates, persists and is honoured");
  p("exactly as it was today.");
  p();

  // --- settled ------------------------------------------------------------
  p("## Rulings — settled, do not relitigate");
  p();
  p("**Five classifications, not three. RATIFIED 2026-07-30.** The brief named `core` / `advanced` /");
  p("`roadmap`; two more were forced by axes that fit none of them:");
  p();
  p("- `request` — `review.payload`, `idempotency_key`, a reviewer's `feedback`. These are the API contract,");
  p("  not controls anyone configures. Calling them `roadmap` would publish \"payload\" as an unbuilt feature.");
  p("- `inert` — axes that are settable, persisted, and do nothing, which the configuration-space spec");
  p("  explicitly rules must be neither deleted (§5.6, §5.8) nor wired (§5.7). Promising them on a public");
  p("  roadmap would promise a no-op.");
  p();
  p("**Ladders are HELD.** Chains ship — routing stays in the engine, and");
  p("sequence is the axis that carries the launch story. Ladders are built and work over the API but have");
  p("no UI on any surface, so shipping them would be new screen work rather than surfacing something that");
  p("already exists. They are named openly on the public roadmap as built-and-held. S4 still designs BOTH");
  p("routing axes so C2 extends the model instead of retrofitting it.");
  p();
  p("Remaining engineering calls, recorded rather than asked, per the working agreement. Overrule freely:");
  p();
  p("- `template.status` (pause/resume) counted under `identity` rather than as a seventh control group,");
  p("  because pause/resume/publish are lifecycle ACTIONS available on every template, not configuration");
  p("  fields. Its own group would make the budget seven.");
  p("- `template.description` kept in the UI as `advanced` rather than pushed to the roadmap, because");
  p("  \"template descriptions\" is not a credible public roadmap line. It overlaps confusingly with");
  p("  `instructions` — two free-text fields with no stated difference. Worth collapsing to one in S4.");
  p();

  // --- budgets -------------------------------------------------------------
  p("## The budgets");
  p();
  p(`- Template editor: **${TEMPLATE_EDITOR_GROUP_BUDGET} control groups** — ${controlGroupsOn("template-editor").join(" · ")}`);
  p(`- An action: **${ACTION_FIELD_BUDGET} fields** — id · label · kind · decision_value`);
  p();
  p("Both are asserted as numbers in `packages/shared/src/__tests__/surface-tiers.test.ts`. Raising either");
  p("requires changing a test, in a pull request, on purpose.");
  p();
  p("Other screens, for context (not budgeted):");
  p();
  for (const s of ["chain-builder", "review-inbox", "share-link-dialog", "settings"]) {
    const groups = controlGroupsOn(s);
    if (groups.length > 0) p(`- \`${s}\`: ${groups.join(" · ")}`);
  }
  p();

  // --- counts --------------------------------------------------------------
  const byTier = {};
  for (const t of TIER_ORDER) byTier[t] = axes.filter((a) => a.declaration.tier === t).length;
  p("## Totals");
  p();
  p("| Tier | Axes |");
  p("|---|---|");
  for (const t of TIER_ORDER) p(`| ${t} | ${byTier[t]} |`);
  p(`| **total** | **${axes.length}** |`);
  p();

  // --- the list ------------------------------------------------------------
  p("## Every axis");
  p();
  p("Ordered by subsystem, then tier. `→` marks where a control lives.");
  p();
  for (const subsystem of Object.keys(SURFACE_TIER_TABLES)) {
    const rows = axes.filter((a) => a.subsystem === subsystem);
    if (rows.length === 0) continue;
    p(`### \`${subsystem}\` — ${rows.length} axes`);
    p();
    p("| Axis | Tier | Where / what |");
    p("|---|---|---|");
    const sorted = [...rows].sort((a, b) => {
      const ta = TIER_ORDER.indexOf(a.declaration.tier);
      const tb = TIER_ORDER.indexOf(b.declaration.tier);
      return ta === tb ? a.axis.localeCompare(b.axis) : ta - tb;
    });
    for (const { axis, declaration } of sorted) {
      let where = "";
      if (declaration.tier === "core" || declaration.tier === "advanced") {
        where = `→ ${declaration.surface} / ${declaration.group}`;
      } else if (declaration.tier === "roadmap") {
        where = `"${declaration.roadmap.feature}" (${declaration.roadmap.built ? "built and held" : "not started"})`;
      }
      const note = declaration.note ? (where ? ` — ${declaration.note}` : declaration.note) : "";
      const cell = (where + note).replace(/\|/g, "\\|").replace(/\n/g, " ");
      p(`| \`${axis}\` | ${declaration.tier} | ${cell} |`);
    }
    p();
  }

  // --- roadmap preview -----------------------------------------------------
  p("## What this publishes");
  p();
  p("The public roadmap is generated from the `roadmap` tier, so held features are named openly and the site");
  p("cannot claim a capability that no schema carries.");
  p();
  const roadmap = publicRoadmap();
  p("**Built and held** — it works today, it is simply not in the UI:");
  p();
  for (const line of roadmap.filter((l) => l.built)) p(`- ${line.feature}  \`(${line.axes.length} axes)\``);
  p();
  p("**Not started** — schema surface exists, the behaviour does not:");
  p();
  for (const line of roadmap.filter((l) => !l.built)) p(`- ${line.feature}  \`(${line.axes.length} axes)\``);
  p();

  // --- exclusions ----------------------------------------------------------
  p("## Deliberately out of scope");
  p();
  p("Declared in source rather than left implicit — a gate that quietly bounds itself reads as full coverage.");
  p();
  for (const x of OUT_OF_SCOPE) {
    p(`### ${x.surface}`);
    p();
    p(x.reason);
    p();
    p(`Examples: ${x.examples.map((e) => `\`${e}\``).join(" · ")}`);
    p();
  }

  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

if (import.meta.main !== false) {
  const generatedDir = join(REPO_ROOT, "docs", "generated");
  mkdirSync(generatedDir, { recursive: true });

  const ratPath = join(generatedDir, "surface-ratification.md");
  writeFileSync(ratPath, buildRatificationMarkdown(), "utf8");

  const siteLibDir = join(REPO_ROOT, "site", "src", "lib");
  mkdirSync(siteLibDir, { recursive: true });
  const roadmapPath = join(siteLibDir, "roadmap-data.json");
  writeFileSync(roadmapPath, JSON.stringify(buildRoadmapPayload(), null, 2) + "\n", "utf8");

  const payload = buildRoadmapPayload();
  console.log("generate-surface-docs:");
  console.log(`  ratification → docs/generated/surface-ratification.md (${allDeclaredAxes().length} axes)`);
  console.log(`  roadmap      → site/src/lib/roadmap-data.json`);
  console.log(`                 ${payload.built_and_held.length} built and held · ${payload.not_started.length} not started`);
}

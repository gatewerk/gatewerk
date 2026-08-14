#!/usr/bin/env node
/**
 * Proves the built OSS bundle carries no Cloud code.
 *
 * The claim being checked is the one the whole OSS/EE boundary rests on: every
 * "@ee/…" import in src/ sits inside a branch gated on isCloud(), Vite folds
 * that to a literal false in a standalone build, and Rollup deletes the branch
 * along with the chunk it would have pulled in. That claim has always been true
 * — and it has always been checked by hand, by grepping a build someone
 * happened to look at.
 *
 * Two things make it worth automating now. First, when the private submodule is
 * absent the "@ee/*" specifiers resolve to a stub planted by vite.config.ts, and
 * a stub that survived elimination would look like a perfectly healthy build.
 * Second, the failure is silent by nature: a bundle that wrongly includes the
 * Cloud layer still boots, still passes every test, and only reveals itself as
 * ~340 KB of Supabase, Sentry and PostHog shipped to self-hosters — which has
 * happened once already on this codebase and was caught by inspecting bundle
 * output, not by a test.
 *
 * Two modes, because the two builds have opposite obligations:
 *
 *   standalone (default) — no Cloud code at all.
 *   cloud                — Cloud code yes, but never the STUB. This catches
 *                          the failure the ee split plan named as its one
 *                          unresolved risk: an image built from a checkout
 *                          where the private submodule was empty compiles
 *                          cleanly, passes health checks, and silently serves
 *                          the OSS login form with no auth layer behind it.
 *                          The stub marker is what makes that state visible,
 *                          and it was found this way rather than reasoned
 *                          about — a cloud build with the submodule
 *                          deinitialised put the marker in nine chunks.
 *
 *   pnpm build && node scripts/assert-no-ee-in-bundle.mjs
 *   pnpm build && node scripts/assert-no-ee-in-bundle.mjs --cloud
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "client");

const CLOUD_MODE = process.argv.includes("--cloud");

// Kept as plain strings so this file has no import relationship with
// vite.config.ts and cannot be defeated by editing one side.
const STUB_MARKER = "__GATEWERK_EE_STUB_MUST_NOT_SHIP__";

// In a cloud build the only forbidden thing is the stub: its presence means the
// submodule was missing at build time and the Cloud layer is hollow.
const FORBIDDEN = CLOUD_MODE
  ? [STUB_MARKER]
  : [
      STUB_MARKER,
      "@supabase/supabase-js",
      "supabase.co",
      "posthog",
      "@sentry/react",
      "sentry.io",
      "turnstile",
    ];

function files(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(js|css|html)$/.test(entry) ? [full] : [];
  });
}

let checked = 0;
const offences = [];

for (const file of files(ASSETS)) {
  checked++;
  const body = readFileSync(file, "utf8");
  for (const needle of FORBIDDEN) {
    if (body.toLowerCase().includes(needle.toLowerCase())) {
      offences.push(`${file.slice(ASSETS.length + 1)}: ${needle}`);
    }
  }
}

if (checked === 0) {
  console.error(`error: no build output under ${ASSETS}. Did you run \`pnpm build\` first?`);
  process.exit(2);
}

if (offences.length > 0) {
  if (CLOUD_MODE) {
    console.error("\nThis cloud bundle has NO Cloud layer in it.\n");
    for (const o of offences) console.error(`  ${o}`);
    console.error(
      "\nThe @ee stub was compiled in, which happens only when the private ee\n" +
        "submodule was absent at build time. The resulting image looks healthy and\n" +
        "serves the OSS login form with no auth behind it. Fix the checkout:\n" +
        "  git submodule update --init --recursive\n",
    );
  } else {
    console.error("\nCloud code found in the standalone bundle:\n");
    for (const o of offences) console.error(`  ${o}`);
    console.error(
      "\nThis means an @ee import escaped dead-code elimination. Check that every\n" +
        "call site is gated on isCloud() and not on a runtime value.\n",
    );
  }
  process.exit(1);
}

console.log(
  CLOUD_MODE
    ? `Cloud bundle carries a real Cloud layer: ${checked} files, no stub.`
    : `OSS bundle clean: ${checked} files, none naming Cloud code.`,
);

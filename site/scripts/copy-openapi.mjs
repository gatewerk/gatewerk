/**
 * Copies the OpenAPI snapshot from the API package into site/public/ so Astro
 * can serve it as a static asset at /openapi.json.
 *
 * Run automatically before every `astro build` (see package.json "build" script).
 * Exits 1 if the snapshot is missing so CI fails loudly rather than publishing
 * a site with a broken API reference.
 */

import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const src = resolve(
  __dirname,
  "../../apps/api/src/openapi/__snapshots__/openapi.snapshot.json",
);
const destDir = resolve(__dirname, "../public");
const dest = resolve(destDir, "openapi.json");

if (!existsSync(src)) {
  console.error(
    `[copy-openapi] ERROR: OpenAPI snapshot not found at:\n  ${src}\n` +
      `Run 'pnpm --filter @gatewerk/api build' (or 'pnpm test' which regenerates the snapshot) first.`,
  );
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

console.log(`[copy-openapi] Copied openapi.snapshot.json → public/openapi.json`);

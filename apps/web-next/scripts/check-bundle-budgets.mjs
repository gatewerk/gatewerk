#!/usr/bin/env node
// Bundle-budget gate for web-next. Runs after `react-router build`.
//
// web-next has no manualChunks and a single catchall route (client-side
// routing lives inside App.tsx, not React Router route modules), so there is
// no per-route or per-vendor split to budget the way apps/web did — Rollup
// just emits a handful of top-level chunks. The two numbers that actually
// mean something for this shape are total JS weight and the single largest
// chunk (currently `catchall`, which is effectively the whole app).
//
// Budgets below are the real gzip sizes measured from a production build
// (total 264,387 B / largest chunk 145,591 B), rounded up with ~20%
// headroom. Fails with a non-zero exit if either is exceeded.
//
// Usage:
//   node scripts/check-bundle-budgets.mjs
//   BUDGET_TOTAL_KB=350 node scripts/check-bundle-budgets.mjs   # allow runtime override

import { readdir, readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, "..", "build", "client", "assets");

const KB = 1024;
const BUDGETS = {
  total: Number(process.env.BUDGET_TOTAL_KB ?? 310) * KB,
  largestChunk: Number(process.env.BUDGET_LARGEST_CHUNK_KB ?? 175) * KB,
};

function fmt(bytes) {
  return `${(bytes / KB).toFixed(2)} KB`;
}

async function getGzipSize(filePath) {
  const buf = await readFile(filePath);
  return gzipSync(buf, { level: 9 }).length;
}

async function main() {
  let entries;
  try {
    entries = await readdir(ASSETS_DIR);
  } catch (err) {
    console.error(`error: could not read ${ASSETS_DIR}. Did you run \`pnpm build\` first?`);
    console.error(err.message);
    process.exit(2);
  }

  const jsEntries = entries.filter((n) => n.endsWith(".js"));

  const chunks = [];
  let totalGzip = 0;

  for (const filename of jsEntries) {
    const filePath = path.join(ASSETS_DIR, filename);
    await stat(filePath);
    const gzip = await getGzipSize(filePath);
    totalGzip += gzip;
    chunks.push({ filename, gzip });
  }

  chunks.sort((a, b) => b.gzip - a.gzip);
  const largest = chunks[0] ?? { filename: "-", gzip: 0 };

  const results = [
    { label: "total JS", actual: totalGzip, budget: BUDGETS.total, detail: `${jsEntries.length} files` },
    { label: "largest single chunk", actual: largest.gzip, budget: BUDGETS.largestChunk, detail: largest.filename },
  ];

  let failed = 0;
  console.log("\nBundle budget check (gzip sizes):\n");
  for (const r of results) {
    const pct = ((r.actual / r.budget) * 100).toFixed(0);
    const ok = r.actual <= r.budget;
    if (!ok) failed++;
    const status = ok ? "PASS" : "FAIL";
    console.log(`  [${status}] ${r.label.padEnd(24)} ${fmt(r.actual).padStart(10)} / ${fmt(r.budget).padStart(10)}  (${pct}%)`);
    console.log(`         ${r.detail}`);
  }

  console.log("\nAll chunks:");
  for (const c of chunks) {
    console.log(`     ${c.filename.padEnd(36)} ${fmt(c.gzip).padStart(10)}`);
  }

  if (failed > 0) {
    console.error(`\n${failed} budget check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} budgets within limits.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

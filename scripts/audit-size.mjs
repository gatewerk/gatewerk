#!/usr/bin/env node
/**
 * audit-size — file-size soft-threshold preview.
 *
 * The ESLint `max-lines` rule enforces the 600-line hard cap at error level
 * (see eslint.config.mjs). ESLint supports only one threshold per rule
 * invocation, so this script surfaces the soft 400-line target.
 * Reviewer-enforced in practice; locally
 * previewable via `pnpm audit:size`.
 *
 * Advisory only — exit 0 regardless of findings. CI gates on the 600 cap
 * via ESLint; this is developer-facing guidance.
 *
 * Scope matches eslint.config.mjs `gatewerk/in-scope-typescript` files minus
 * test files, generated files, *.d.ts, and SDK packages. Line count is raw
 * (every line), which is stricter than ESLint's `skipBlankLines: true,
 * skipComments: true`. A file can be 410 raw lines but 380 under the ESLint
 * counting rules; the intent is to flag early, not match exactly.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOFT = 400;
const HARD = 600;

const ROOTS = [
  "apps/web-next/src",
  "packages/web-core/src",
  "apps/api/src",
  "packages/shared/src",
  "packages/db/src",
];

const INCLUDE_EXT = [".ts", ".tsx"];
const EXCLUDE_PATTERNS = [
  /\.d\.ts$/,
  /\.test\.(ts|tsx)$/,
  /\.gen\.ts$/,
  /\.generated\.ts$/,
  /routeTree\.gen\./,
  /\/\+types\//,
  /\/__tests__\//,
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "build" || name === ".react-router" || name === ".vite" || name === ".turbo" || name === "coverage") continue;
      walk(full, out);
      continue;
    }
    if (!INCLUDE_EXT.some((ext) => name.endsWith(ext))) continue;
    if (EXCLUDE_PATTERNS.some((re) => re.test(full))) continue;
    out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)));

const counts = files.map((path) => {
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n").length;
  return { path: relative(REPO_ROOT, path), lines };
});

const overHard = counts.filter((c) => c.lines >= HARD).sort((a, b) => b.lines - a.lines);
const overSoft = counts.filter((c) => c.lines >= SOFT && c.lines < HARD).sort((a, b) => b.lines - a.lines);
const total = counts.length;
const maxFile = counts.reduce((m, c) => (c.lines > m.lines ? c : m), { lines: 0, path: "(none)" });

console.log(`audit-size: ${total} in-scope files; largest = ${maxFile.path} (${maxFile.lines})`);
console.log(`  soft target: < ${SOFT} lines  |  hard cap (ESLint-enforced): < ${HARD}\n`);

if (overHard.length > 0) {
  console.log(`ERROR: ${overHard.length} file(s) at or over hard cap ${HARD}:`);
  for (const c of overHard) console.log(`  ${c.lines.toString().padStart(5)}  ${c.path}`);
  console.log("");
}

if (overSoft.length > 0) {
  console.log(`WARN: ${overSoft.length} file(s) over soft target ${SOFT} (not blocking):`);
  for (const c of overSoft) console.log(`  ${c.lines.toString().padStart(5)}  ${c.path}`);
  console.log("");
}

if (overHard.length === 0 && overSoft.length === 0) {
  console.log("All files under soft target. Nothing to report.");
}

process.exit(0);

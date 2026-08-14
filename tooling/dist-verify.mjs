#!/usr/bin/env node
// tooling/dist-verify.mjs
//
// Per-package gate that re-runs `pnpm build` for the current package and
// asserts that `git diff --quiet -- dist/` returns 0 (i.e. no drift
// between the committed dist/ and what the build emits right now).
//
// Invoked from each published package's `dist:verify` script. The
// success signal is the git exit code, never stdout. Uses execFileSync
// with array argv so paths with spaces never matter and no string is
// ever interpolated into a command line.
//
// Modes:
//   default      — re-run build, then assert dist/ has no git diff.
//   --no-git-check — re-run build, just confirm dist/ exists. Use for
//                    packages that do not commit dist/ to git.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const pkgRoot = process.cwd();
const distDir = resolve(pkgRoot, "dist");
const noGitCheck = process.argv.includes("--no-git-check");
const pkgJsonPath = resolve(pkgRoot, "package.json");
const pkgName = JSON.parse(readFileSync(pkgJsonPath, "utf8")).name;

console.log(`[dist-verify] package=${pkgName} no-git-check=${noGitCheck}`);

// Step 1: rebuild.
execFileSync("pnpm", ["build"], { cwd: pkgRoot, stdio: "inherit" });

// Step 2: artifact existence sanity check.
if (!existsSync(distDir)) {
  console.error(`[dist-verify] FAIL: ${distDir} does not exist after build`);
  process.exit(1);
}

if (noGitCheck) {
  console.log(`[dist-verify] OK: ${pkgName} built (--no-git-check mode)`);
  process.exit(0);
}

// Step 3: confirm no drift via git diff --quiet --exit-code on dist/.
try {
  execFileSync(
    "git",
    ["diff", "--quiet", "--exit-code", "--", distDir],
    { cwd: pkgRoot, stdio: "ignore" },
  );
  console.log(`[dist-verify] OK: ${pkgName} dist/ matches source`);
} catch {
  console.error(`[dist-verify] FAIL: ${pkgName} dist/ drift detected after build.`);
  console.error(`[dist-verify] Run: pnpm --filter ${pkgName} build, then commit the dist/ delta.`);
  try {
    execFileSync(
      "git",
      ["--no-pager", "diff", "--", distDir],
      { cwd: pkgRoot, stdio: "inherit" },
    );
  } catch { /* printing is best-effort */ }
  process.exit(1);
}

#!/usr/bin/env node
// Decides which test jobs a push/PR needs, from the git diff alone — it runs
// before any pnpm install exists to ask. The dependency graph is read from the
// workspace manifests every run, so the map cannot go stale.
//
// env in:  BASE_SHA (empty or all-zeros forces a full run), HEAD_SHA
// outputs: base — BASE_SHA passed through (empty on a full run)
//          full — "true" when the diff cannot be scoped to workspace packages;
//                 a lockfile or workflow change must never skip the suite
//          api  — "true" when @gatewerk/api or a package it depends on changed
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const out = (k, v) => {
  const line = `${k}=${v}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  process.stdout.write(line);
};

const fullRun = (reason) => {
  console.log(`full run: ${reason}`);
  out("base", "");
  out("full", "true");
  out("api", "true");
  process.exit(0);
};

const base = process.env.BASE_SHA ?? "";
const head = process.env.HEAD_SHA ?? "HEAD";

if (!base || /^0+$/.test(base)) fullRun("no usable base sha");
try {
  execFileSync("git", ["cat-file", "-e", `${base}^{commit}`], { stdio: "pipe" });
} catch {
  fullRun(`base ${base} is not in this clone`);
}

const diff = execFileSync("git", ["diff", "--name-only", base, head], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

// Package dirs mirror pnpm-workspace.yaml (packages/*, apps/*, site). The
// workspace file itself lives outside every package, so editing it forces a
// full run through the check below rather than silently drifting from this list.
const pkgDirs = [];
for (const parent of ["packages", "apps"]) {
  for (const d of readdirSync(parent, { withFileTypes: true })) {
    if (d.isDirectory() && existsSync(join(parent, d.name, "package.json"))) {
      pkgDirs.push(`${parent}/${d.name}`);
    }
  }
}
if (existsSync("site/package.json")) pkgDirs.push("site");

const dirOf = (file) => pkgDirs.find((p) => file.startsWith(p + "/"));

const changedDirs = new Set();
for (const f of diff) {
  const d = dirOf(f);
  if (!d) fullRun(`${f} is outside every package`);
  changedDirs.add(d);
}

const byName = new Map();
for (const dir of pkgDirs) {
  const j = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  byName.set(j.name, {
    dir,
    deps: Object.keys({ ...j.dependencies, ...j.devDependencies }),
  });
}
const nameOfDir = new Map([...byName].map(([n, v]) => [v.dir, n]));

// affected = changed packages plus their transitive dependents
const affected = new Set([...changedDirs].map((d) => nameOfDir.get(d)));
let grew = true;
while (grew) {
  grew = false;
  for (const [name, { deps }] of byName) {
    if (affected.has(name)) continue;
    if (deps.some((d) => affected.has(d))) {
      affected.add(name);
      grew = true;
    }
  }
}

console.log("affected:", [...affected].join(", ") || "(none)");
out("base", base);
out("full", "false");
out("api", affected.has("@gatewerk/api") ? "true" : "false");

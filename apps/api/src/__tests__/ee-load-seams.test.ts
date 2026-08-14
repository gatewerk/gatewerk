/*
 * Every place OSS code reaches into the private ee tree, checked in one go.
 *
 * Why this exists: the ee split moved that tree from apps/api/ee to the repo
 * root, and nine separate call sites carried a hardcoded relative specifier to
 * it. The eslint no-ee-imports rule deliberately permits dynamic imports, so
 * it flagged none of them, and TypeScript cannot see through the
 * function-returning-string indirection that keeps the boundary type-clean.
 * The result was nine silent breakages that only surfaced as runtime failures
 * deep inside unrelated route tests.
 *
 * Two properties are asserted:
 *
 * 1. The specifier is built from import.meta.url, not left as a bare relative
 *    string. vite resolves a dynamic specifier against the importer's path
 *    relative to the VITE ROOT (apps/api for this package), so a relative
 *    climb to the repo root gets clamped and silently resolves to a literal
 *    /ee/... filesystem path under vitest while still working under Bun. That
 *    split-brain is the exact failure this guards.
 *
 * 2. Each specifier names a file that actually exists — checked only when the
 *    submodule is checked out, because its absence is the supported OSS state.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const SRC = join(__dirname, "..");
const REPO = join(SRC, "..", "..", "..");
const EE_PRESENT = existsSync(join(REPO, "ee", "api"));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

// The sanctioned form: new URL("<relative>", import.meta.url).href
const SEAM = /new URL\(\s*"((?:\.\.\/)+ee\/[^"]+)"\s*,\s*import\.meta\.url\s*\)/g;

const seams = files.flatMap((f) =>
  [...f.text.matchAll(SEAM)].map((m) => ({ file: f.path, specifier: m[1] })),
);

describe("ee load seams", () => {
  it("finds every seam, so the checks below cannot go vacuous", () => {
    // Ten at the time of the split, eleven once the Resend transport was ruled
    // Cloud-only and moved out. A drop means a seam was deleted or rewritten
    // into a form this regex no longer recognises — either way, look before
    // lowering this number.
    expect(seams.length).toBeGreaterThanOrEqual(11);
  });

  it("never reaches ee through a bare relative specifier", () => {
    const bare = /=>\s*"(?:\.\.\/)+ee\//;
    const offenders = files
      .filter((f) => bare.test(f.text))
      .map((f) => f.path.slice(SRC.length + 1));
    expect(offenders, "bare relative ee specifier breaks under vite's root clamping").toEqual([]);
  });

  it.skipIf(!EE_PRESENT)("points every seam at a file that exists", () => {
    const missing = seams
      .map(({ file, specifier }) => {
        // Specifiers carry a .js extension; both Bun and vite map that onto
        // the .ts source on disk, so check for either.
        const target = resolve(dirname(file), specifier);
        const ok = existsSync(target) || existsSync(target.replace(/\.js$/, ".ts"));
        return ok ? null : `${file.slice(SRC.length + 1)} -> ${specifier}`;
      })
      .filter(Boolean);
    expect(missing).toEqual([]);
  });
});

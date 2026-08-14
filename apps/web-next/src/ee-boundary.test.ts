/**
 * The OSS bundle's only structural defence.
 *
 * Cloud code lives in apps/web-next/ee and reaches the app exclusively through
 * `isCloud() ? lazy(() => import("@ee/…")) : null`. isCloud() compares
 * import.meta.env.VITE_GATEWERK_MODE directly, so Vite folds it to a literal
 * and Rollup deletes the branch — and the chunk with it — from a standalone
 * build.
 *
 * A single STATIC `import … from "@ee/…"` anywhere under src/ silently converts
 * that elimination into ordinary lazy-loading: the app still works, tests still
 * pass, and Supabase, Sentry and PostHog quietly ship to self-hosters. The same
 * class of mistake (routing the gate through a runtime env object) already cost
 * ~340 KB once and was only caught by inspecting bundle output.
 *
 * That is expensive to notice and cheap to assert, so assert it here. The build
 * grep in ee/README.md remains the end-to-end proof; this is the fast one that
 * names the offending file.
 *
 * KNOWN LIMIT, so nobody mistakes a green run for a guarantee: the gate check
 * below is per-FILE co-occurrence, not structural. A file that legitimately
 * gates one import can carry a second, ungated one and still pass, because a
 * regex cannot tell which condition encloses which call site. Closing that
 * needs an AST rule, not a bigger pattern. The build grep is what actually
 * proves the bundle is clean; this test is here to catch the common mistake
 * early and point at the file.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: path.slice(SRC.length + 1),
  text: readFileSync(path, "utf8"),
}));

// Every way to name the cloud directory from src/. The "@ee/" alias is the
// intended spelling, but a relative climb reaches the same files and would sail
// past a gate that only knew the alias — the first version of this test had
// exactly that hole. Matched on the specifier, so
// both spellings are covered wherever they appear.
const EE_SPECIFIER = String.raw`(?:@ee/|(?:\.\./)+ee/)`;

describe("ee boundary", () => {
  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("names the cloud directory somewhere, so the gate is not vacuous", () => {
    // If the wiring is ever removed, these assertions would all pass trivially.
    const naming = files.filter((f) => new RegExp(EE_SPECIFIER).test(f.text));
    expect(naming.length).toBeGreaterThan(0);
  });

  it("never imports the cloud directory statically from src/", () => {
    // A static import is `import … from "<ee>"` or a bare `import "<ee>"`,
    // including `import type`. The permitted dynamic form always has an open
    // paren before the quote, which `\sfrom\s*` and the bare form both exclude.
    const staticImport = new RegExp(
      String.raw`import\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s*)?["']` + EE_SPECIFIER,
    );
    const offenders = files.filter((f) => staticImport.test(f.text)).map((f) => f.path);
    expect(offenders, "static cloud import defeats dead-code elimination").toEqual([]);
  });

  it("never re-exports the cloud directory from src/", () => {
    const reExport = new RegExp(String.raw`export\s+[\s\S]*?\sfrom\s*["']` + EE_SPECIFIER);
    const offenders = files.filter((f) => reExport.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("gates every cloud import on a build-time-foldable condition", () => {
    // Either spelling folds at build time and so permits elimination:
    // isCloud() (which is itself just this comparison), or the comparison
    // inline — which is what a class component's componentDidCatch uses, since
    // importing isCloud() there would pull web-core in for one boolean.
    // What must never appear is a gate on a runtime value.
    const foldableGate = /isCloud\(\)|import\.meta\.env\.VITE_GATEWERK_MODE\s*===\s*["']cloud["']/;
    const offenders = files
      .filter((f) => new RegExp(EE_SPECIFIER).test(f.text))
      .filter((f) => !foldableGate.test(f.text))
      .map((f) => f.path);
    expect(offenders, "names the cloud directory without a foldable gate").toEqual([]);
  });
});

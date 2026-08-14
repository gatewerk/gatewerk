// @vitest-environment node
//
// Node, not the suite's jsdom default: this file imports the real vite.config.ts,
// and the react-router plugin it pulls in trips over jsdom's TextEncoder
// ("new TextEncoder().encode('') instanceof Uint8Array" is false there).

/**
 * Guards the gap that let a broken dev server ship green.
 *
 * Nothing in CI touches the dev server's SSR module graph, so a broken
 * `react-router dev` module resolution can ship while lint, typecheck, every
 * test suite, and both production builds and Docker images stay clean.
 *
 * The mechanism: Vite's SSR environment externalizes anything that resolves
 * into node_modules and hands it to Node. pnpm symlinks workspace packages into
 * node_modules, so a source-only workspace package qualifies. Node then reads
 * its package.json for `main`/`exports`, and a package that ships raw
 * TypeScript has neither — nor could it usefully, since Node cannot execute
 * TypeScript. The fix is `ssr.noExternal`, which keeps the package inside
 * Vite's pipeline where the alias applies and the source is compiled.
 *
 * This asserts the rule rather than the single instance: any workspace
 * dependency with no runtime entry point must be listed in the consuming app's
 * ssr.noExternal. The next package extracted out of apps/web gets caught here
 * instead of in someone's browser.
 *
 * It reads the RESOLVED config object, not the file's text. The first version
 * of this test grepped the source for "noExternal" and passed happily with the
 * fix deleted, because the comment above the setting says the word too.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = path.resolve(__dirname, "../../../..");
const APPS = ["apps/web-next"];

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  main?: string;
  module?: string;
  exports?: unknown;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(path.join(REPO, dir, "package.json"), "utf8"));
}

/** Workspace deps of an app, as [name, directory] pairs. */
function workspaceDeps(app: string): Array<[string, string]> {
  const pkg = readManifest(app);
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return Object.entries(all)
    .filter(([, spec]) => spec.startsWith("workspace:"))
    .map(([name]) => [name, name.replace("@gatewerk/", "packages/")] as [string, string])
    .filter(([, dir]) => existsSync(path.join(REPO, dir, "package.json")));
}

/** A package Node cannot load on its own: no main, no module, no exports. */
function shipsRawSource(dir: string): boolean {
  const m = readManifest(dir);
  return !m.main && !m.module && !m.exports;
}

/**
 * Importing a real vite.config.ts pulls in the react-router plugin and takes a
 * few seconds, which is most of this file's runtime. Memoised so the four tests
 * that need a config share two loads rather than doing eight.
 */
const configCache = new Map<string, Promise<Record<string, any>>>();

async function loadConfig(app: string): Promise<Record<string, any>> {
  const cached = configCache.get(app);
  if (cached) return cached;
  const loading = (async () => {
    const mod = await import(pathToFileURL(path.join(REPO, app, "vite.config.ts")).href);
    const raw = mod.default;
    return typeof raw === "function" ? await raw({ command: "serve", mode: "development" }) : raw;
  })();
  configCache.set(app, loading);
  return loading;
}

/**
 * Vitest's 5s default is not enough for a test whose real work is importing two
 * Vite configs: it measured 5030ms on a loaded machine and failed as a timeout,
 * intermittently, with no assertion involved. Raised rather than trimmed —
 * loading the actual config is the entire point of this file (an earlier version
 * grepped the source text and passed with the fix deleted).
 */
const CONFIG_LOAD_TIMEOUT_MS = 30_000;

/** The app's ssr.noExternal, as actually resolved by loading the config. */
async function resolvedNoExternal(app: string): Promise<string[]> {
  const value = (await loadConfig(app))?.ssr?.noExternal;
  if (value === true) return ["*"]; // blanket noExternal covers everything
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(String);
  return [];
}

/**
 * Libraries that break when two copies load at once, because they keep
 * module-level state that consumers compare by identity: React's hook dispatcher
 * and every context object, react-router's framework context.
 */
const SINGLETON_LIBS = ["react", "react-dom", "react-router"];

function declaresRuntime(dir: string, lib: string): boolean {
  const m = readManifest(dir);
  // peerDependencies alone do not install a copy; dependencies and
  // devDependencies both do under pnpm's isolated layout.
  return Boolean(m.dependencies?.[lib] || m.devDependencies?.[lib]);
}

describe("SSR externals", () => {
  for (const app of APPS) {
    it(`${app} declares every source-only workspace dep in ssr.noExternal`, { timeout: CONFIG_LOAD_TIMEOUT_MS }, async () => {
      const sourceOnly = workspaceDeps(app)
        .filter(([, dir]) => shipsRawSource(dir))
        .map(([name]) => name);
      if (sourceOnly.length === 0) return;

      const noExternal = await resolvedNoExternal(app);

      for (const name of sourceOnly) {
        // A source-only package left out of noExternal is externalized to Node,
        // which cannot execute its TypeScript. Production builds stay green;
        // the dev server 500s on every request.
        expect(
          noExternal.includes(name) || noExternal.includes("*"),
          `${app}/vite.config.ts must list "${name}" in ssr.noExternal — it ships TypeScript source with no main/module/exports, so Vite must compile it instead of handing it to Node. Resolved noExternal: ${JSON.stringify(noExternal)}`,
        ).toBe(true);
      }
    });
  }

  // The dedupe half of the same lesson. web-core keeps react and react-router
  // in devDependencies so it can typecheck its own hooks, and pnpm gives it real
  // copies under packages/web-core/node_modules. Without dedupe a hook defined
  // in web-core runs against a different React than the app that rendered it,
  // and the whole authenticated shell dies on "Cannot read properties of null
  // (reading 'useContext')". The ssr.noExternal fix above did not prevent this —
  // two separate mistakes, one extraction.
  for (const app of APPS) {
    it(`${app} dedupes every singleton library a workspace dep installs its own copy of`, { timeout: CONFIG_LOAD_TIMEOUT_MS }, async () => {
      const needsDedupe = new Set<string>();
      for (const [, dir] of workspaceDeps(app)) {
        for (const lib of SINGLETON_LIBS) {
          if (declaresRuntime(dir, lib)) needsDedupe.add(lib);
        }
      }
      if (needsDedupe.size === 0) return;

      const dedupe: string[] = (await loadConfig(app))?.resolve?.dedupe ?? [];
      for (const lib of needsDedupe) {
        expect(
          dedupe.includes(lib),
          `${app}/vite.config.ts must list "${lib}" in resolve.dedupe — a workspace dependency installs its own copy, and two instances of ${lib} in one app break every hook and context lookup. Resolved dedupe: ${JSON.stringify(dedupe)}`,
        ).toBe(true);
      }
    });
  }

  it("web-core is still a source-only package, so the rule above still applies", () => {
    // If web-core ever grows a build step, this flips and the guard can relax.
    // Failing here is a prompt to re-read the rule, not a bug.
    expect(shipsRawSource("packages/web-core")).toBe(true);
  });
});

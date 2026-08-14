/**
 * How this app resolves the Cloud tree, in one place.
 *
 * vite.config.ts and vitest.config.ts both need it and must agree. They did
 * not, briefly: the build config got the stub resolver and the test config only
 * got the conditional alias, so with the submodule absent `pnpm build` worked
 * and `pnpm test` failed to load every file naming "@ee/…". Two copies of this
 * logic is exactly one copy too many, so there is now one.
 *
 * The Cloud tree lives in the private ./ee submodule at the repo root. A public
 * clone leaves that directory empty, which is a supported state — see
 * apps/api/src/__tests__/oss-tree-has-no-ee.test.ts.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import type { Plugin } from "vite";

export const EE_WEB_NEXT = path.resolve(__dirname, "../../ee/web-next");
export const EE_PRESENT = existsSync(EE_WEB_NEXT);

/**
 * Planted in the stub module below, and asserted absent from built output by
 * scripts/assert-no-ee-in-bundle.mjs. Exported so there is a single spelling,
 * though that script deliberately hardcodes its own copy so the two cannot be
 * defeated by one edit.
 */
export const EE_STUB_MARKER = "__GATEWERK_EE_STUB_MUST_NOT_SHIP__";

/**
 * The "@ee" alias, declared only when it resolves. An alias pointing at a
 * missing directory turns a clean absence into a resolve error.
 */
export const eeAlias = (): Record<string, string> =>
  EE_PRESENT ? { "@ee": EE_WEB_NEXT } : {};

/**
 * Answers "@ee/*" with an empty virtual module when the submodule is absent.
 *
 * This exists because of a Rollup behaviour that is easy to get wrong. src/
 * reaches the Cloud tree only through branches gated on isCloud(), which Vite
 * constant-folds to false in a standalone build, and the resulting dead code is
 * eliminated — that part is real, and it is why the OSS bundle has never
 * contained a byte of Supabase, Sentry or PostHog.
 *
 * What does NOT follow is that an absent "@ee" therefore costs nothing. Rollup
 * builds the module graph BEFORE it eliminates anything: it calls
 * resolveDynamicImport on `import("@ee/…")` while the branch is still standing,
 * and an unresolvable specifier is a hard build failure. Vitest's transform
 * pipeline rejects it even earlier, at import analysis, before any branch is
 * evaluated at all. Both were measured, not assumed.
 *
 * So the graph gets an empty module, which is then eliminated exactly as the
 * real one would have been. The marker is how "would have been" is verified
 * rather than believed.
 */
export function eeAbsentStub(): Plugin {
  const PREFIX = "\0gatewerk-ee-absent:";
  return {
    name: "gatewerk:ee-absent-stub",
    enforce: "pre",
    resolveId(source: string) {
      return source === "@ee" || source.startsWith("@ee/") ? PREFIX + source : null;
    },
    load(id: string) {
      if (!id.startsWith(PREFIX)) return null;
      // Deliberately inert. Every consumer sits inside an eliminated branch, so
      // nothing here is ever evaluated; if that stops being true the marker
      // survives into the bundle and the build fails loudly.
      return `export const ${EE_STUB_MARKER} = true;\nexport default {};\n`;
    },
  };
}

/** Spread into a `plugins` array: the stub, only when it is needed. */
export const eePlugins = (): Plugin[] => (EE_PRESENT ? [] : [eeAbsentStub()]);

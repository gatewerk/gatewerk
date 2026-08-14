import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // Preserve vitest's built-in excludes (node_modules, dist, .git, etc.)
    // and add dist-cloud — the EE-only build output (pnpm build:cloud emits
    // there). Without this, running `pnpm build:cloud` before `pnpm test`
    // causes vitest to discover compiled .js test duplicates and inflate
    // the count (1145 → 1245 with ~100 spurious duplicates).
    exclude: [...configDefaults.exclude, "**/dist-cloud/**"],
    hookTimeout: 30000,
    testTimeout: 15000,
    env: {
      SKIP_HIBP: "true",
      SKIP_DNS_SSRF: "true",
      // Seed for the t3-env skipValidation test-mode footgun: the schema in
      // env.ts declares SESSION_INACTIVITY_TIMEOUT_HOURS as
      // z.coerce.number().default(24), but skipValidation bypasses the
      // default at parse time. Consumers (auth-helpers.ts, sessions.ts)
      // multiply this as if guaranteed-number; absence would produce
      // NaN arithmetic and sessions would never inactivate in tests.
      // Stringly-typed because vitest env values are strings; the schema
      // coerces.
      SESSION_INACTIVITY_TIMEOUT_HOURS: "24",
    },
  },
});

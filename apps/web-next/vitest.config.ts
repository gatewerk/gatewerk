import { defineConfig } from "vitest/config";
import path from "path";
// Shared with vite.config.ts, and shared on purpose. This file previously
// declared only the conditional "@ee" alias and not the stub plugin, so with
// the submodule absent `pnpm build` succeeded while `pnpm test` failed to load
// every file naming "@ee/…" — vitest rejects an unresolvable specifier at
// import analysis, earlier than Rollup does, and long before the isCloud()
// branch guarding it could be evaluated. See ee-resolve.ts.
import { eeAlias, eePlugins } from "./ee-resolve";

export default defineConfig({
  define: {
    // Shared with vite.config.ts. npm_package_version is set by pnpm for
    // script-invoked processes; the fallback covers direct vitest/vite
    // invocations where it is unset.
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0-dev"),
  },
  plugins: [...eePlugins()],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
      ...eeAlias(),
      "@gatewerk/web-core": path.resolve(__dirname, "../../packages/web-core/src"),
    },
  },
  test: { environment: "jsdom", globals: true },
});

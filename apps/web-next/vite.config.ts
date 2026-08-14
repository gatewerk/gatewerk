import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import viteCompression from "vite-plugin-compression";
import path from "path";
// Shared with vitest.config.ts. The two configs must agree about the Cloud
// tree, and when they were written separately they did not — see ee-resolve.ts.
import { EE_PRESENT, eeAlias, eePlugins } from "./ee-resolve";

const devApiTarget = process.env.GATEWERK_DEV_API || "http://localhost:3100";


export default defineConfig({
  define: {
    // Shared with vitest.config.ts. npm_package_version is set by pnpm for
    // script-invoked processes; the fallback covers direct vitest/vite
    // invocations where it is unset.
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0-dev"),
  },
  plugins: [
    reactRouter(),
    tailwindcss(),
    // Precompressed assets for nginx. docker/nginx.conf enables `gzip_static on`
    // and nothing else — there is no `gzip on` fallback — so without a .gz
    // sibling nginx serves every bundle uncompressed and silently. Measured on
    // the first web-next image: root CSS came back at 34,770 bytes with
    // `Accept-Encoding: gzip` and no `Content-Encoding` header.
    //
    // gzip only, unlike apps/web which also emits .br: the stock
    // nginx:stable-alpine runtime has no brotli module, so .br files are
    // unservable weight.
    viteCompression({ algorithm: "gzip", ext: ".gz", threshold: 1024 }),
    ...eePlugins(),
  ],
  resolve: {
    // web-core keeps react and react-router in devDependencies so it can
    // typecheck its own hooks, and pnpm gives it real copies under
    // packages/web-core/node_modules. Without dedupe, a hook living in web-core
    // imports THAT react while the app imports its own: two React instances,
    // every hook call invalid, and the app dies on "Cannot read properties of
    // null (reading 'useContext')" the moment a signed-in route renders.
    // react-router duplicates the same way and takes <Meta> down with it.
    dedupe: ["react", "react-dom", "react-router"],
    alias: {
      "~": path.resolve(__dirname, "./src"),
      // Cloud-only bundle. It sits outside src/ so the OSS build can drop it
      // wholesale: every entry point is reached through
      // `isCloud() ? lazy(() => import("@ee/…")) : null`, and isCloud() is a
      // direct import.meta.env read that Vite constant-folds, so Rollup deletes
      // the branch and never emits the chunk.
      //
      // It now lives in the private ./ee submodule, so on a public clone the
      // directory is simply not there. The alias is declared only when it
      // resolves; when it does not, the stub plugin above answers instead.
      ...eeAlias(),
      // Resolved by alias rather than by package `exports`: web-core is a
      // source-only workspace package whose modules are a mix of .ts and .tsx,
      // and an `exports` wildcard cannot express "try both extensions" without
      // fallback arrays that Vite and tsc honour inconsistently. This is the
      // same mechanism that resolved `@` before the extraction.
      "@gatewerk/web-core": path.resolve(__dirname, "../../packages/web-core/src"),
    },
  },
  optimizeDeps: {
    // Cloud-only deps, listed so the dev server prebundles them at startup.
    //
    // They are reached exclusively through `isCloud() ? lazy(() => import(
    // "@ee/…")) : null`, so Vite cannot see them while crawling the entry graph
    // and only discovers them when the first cloud chunk is requested. That
    // mid-session discovery triggers a re-optimize and a reload, and the two
    // React libraries here (@sentry/react, @marsidev/react-turnstile) each
    // carry a nested react symlink under pnpm — so the re-optimized bundle
    // ended up holding a second React instance and every hook call threw
    // "Invalid hook call … more than one copy of React", leaving the cloud dev
    // server rendering a blank page.
    //
    // Naming them up front means one optimization pass, one React. Costs
    // nothing in a standalone dev server (they prebundle and go unused) and
    // nothing in any build — optimizeDeps is dev-only, so this does not put a
    // single byte into the OSS bundle.
    // Conditional now that these are declared by the ee submodule rather than
    // by this app. On a public clone they are not installed at all, and naming
    // an uninstallable package here makes the dev server fail its optimize
    // pass on startup instead of quietly having nothing to prebundle.
    include: EE_PRESENT
      ? ["@supabase/supabase-js", "@sentry/react", "posthog-js", "@marsidev/react-turnstile"]
      : [],
  },
  ssr: {
    // web-core ships TypeScript source, not a build. Vite's SSR default is to
    // externalize anything resolving into node_modules and hand it to Node —
    // and pnpm symlinks workspace packages into node_modules, so web-core
    // qualified. Node then looked for main/exports in its package.json, found
    // neither, and `react-router dev` died with "Cannot find module
    // @gatewerk/web-core/hooks/use-auth" on every request.
    //
    // noExternal keeps it inside Vite's pipeline, where the alias above applies
    // and the .ts is actually compiled. An exports map would not have been
    // enough on its own: Node cannot execute TypeScript.
    //
    // The client build never hit this (SPA mode, alias applies), which is why
    // lint, typecheck, tests and `react-router build` were all green while the
    // dev server was returning 500.
    noExternal: ["@gatewerk/web-core"],
  },
  server: {
    port: 5174,
    fs: { allow: [path.resolve(__dirname, "../..")] },
    proxy: {
      // Dev API target. Defaults to a locally-run API on :3100 (cd apps/api &&
      // bun run dev). Override to the live API for verification when local
      // secrets are absent: GATEWERK_DEV_API=https://api.gatewerk.com pnpm ... dev
      "/api": { target: devApiTarget, changeOrigin: true },
      "/health": { target: devApiTarget, changeOrigin: true },
    },
  },
});

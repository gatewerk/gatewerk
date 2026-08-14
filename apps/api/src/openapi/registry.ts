// Central OpenAPI registry for the Gatewerk API.
//
// Usage:
//   import { registry } from "./registry";
//   registry.register("ReviewCreateBody", ReviewCreateBodySchema);
//   registry.registerPath({ method: "post", path: "/api/v1/reviews", ... });
//
// Consumed by `generator.generateComponents()` in index.ts. Paths remain
// hand-authored and are spread into the document alongside the generated
// components.
//
// Rules:
//   1. Import `registry` (singleton), never `new OpenAPIRegistry()`.
//   2. Schemas must be registered with `registry.register()` before being
//      referenced via `z.lazy(() => ...)` or `.openapi()` in path defs.
//   3. Path files call `registry.registerPath()` as a side effect on import.
//      Import them all in index.ts so the side effects fire.
//
// `extendZodWithOpenApi(z)` must be called once before any `.openapi()` chain;
// it lives here as the canonical bootstrap so consumers don't need to repeat it.

import { z } from "zod";
import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

// Global Zod-prototype mutation: extendZodWithOpenApi adds `.openapi()` to all
// Zod schemas in the process. Idempotent (re-calling is a no-op). Safe at
// module-load time because nothing in the schema test suite snapshots Zod
// shape — only OpenAPI output is snapshotted (see parity.test.ts).
extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// Re-exported so consumers that want to extend additional Zod schemas (e.g.
// per-package overrides in EE code) don't need a direct dependency on the
// underlying package — keeps the bootstrap site canonical.
export { extendZodWithOpenApi };

// Snapshot parity test: ensures the OpenAPI document generated from the
// registry exactly matches the golden snapshot captured before the migration.
//
// WHEN TO UPDATE THE SNAPSHOT:
//   Only when you intentionally change the API surface (new endpoint, schema
//   change). Regenerate by running, from the apps/api directory:
//     bun -e "import('./src/openapi/index.ts').then(m => require('fs').writeFileSync('src/openapi/__snapshots__/openapi.snapshot.json', JSON.stringify(m.openApiDocument, null, 2)))"
//   Do NOT update the snapshot to silence a parity failure — investigate the
//   drift instead. Drift is usually a real bug; intentional API-surface
//   change is rare.
//
// HOW THIS GUARDS THE GENERATOR:
//   apps/api/src/openapi/index.ts builds components.schemas from the
//   @asteasolutions/zod-to-openapi registry. If a Zod schema definition
//   drifts from the JSON-Schema shape the consumers expect, this test
//   catches it before the regression reaches a generated SDK.
//
// JSON-IMPORT PATH: resolveJsonModule=true (tsconfig.base.json) — direct
// import used. No fs.readFileSync fallback needed.
//
// PATH COUNT NOTE: The audit comment in index.ts references "30 operationIds"
// across 25 distinct paths (some paths have multiple HTTP methods). The
// snapshot and test use the correct path count of 25.
//
// TOEQUAL PATH: openApiDocument is an `as const` TypeScript object with
// readonly/literal-type inference. JSON.parse(JSON.stringify(...)) round-trip
// is used to strip TypeScript readonly markers before deep-equal comparison,
// ensuring structural equivalence against the plain-JSON snapshot.

import { describe, it, expect } from "vitest";
import { openApiDocument } from "../index";
import snapshot from "../__snapshots__/openapi.snapshot.json";

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "trace"]);

describe("OpenAPI spec parity", () => {
  // Tests 2 (path count) and 3 (openapi version) are intentionally redundant
  // with test 1 (deep-equal snapshot) — they exist for fast triage when the
  // headline deep-equal fails. Keep them.
  it("generated document matches golden snapshot", () => {
    // JSON.parse(JSON.stringify(...)) strips TypeScript `as const` readonly
    // markers so deep-equal comparison works against the plain-JSON snapshot.
    // If this fails, either:
    //   (a) You added/changed an endpoint — update the snapshot intentionally.
    //   (b) A Zod registration drifted from the committed snapshot — fix the
    //       registration. DO NOT regenerate the snapshot to silence a failure
    //       unless the API surface intentionally changed.
    expect(JSON.parse(JSON.stringify(openApiDocument))).toEqual(snapshot);
  });

  it("contains the expected number of path entries", () => {
    // 25: +1 from /reviews/{id}/action + ReviewActionBody.
    expect(Object.keys(openApiDocument.paths).length).toBe(25);
  });

  it("has openapi version 3.1.0", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
  });

  it("every $ref in paths resolves to a registered schema", () => {
    const refs = new Set<string>();
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "$ref" && typeof value === "string") {
          refs.add(value);
        } else {
          walk(value);
        }
      }
    };
    walk(openApiDocument.paths);
    walk(openApiDocument.components.schemas as Record<string, unknown>);
    const schemas = openApiDocument.components.schemas as Record<string, unknown>;
    // Only validate schema refs — response/parameter refs are validated
    // separately by OpenAPI tooling. Non-schema refs (e.g. #/components/responses/*)
    // are skipped here to keep the assertion scope narrow and readable.
    const schemaRefs = [...refs].filter((r) => r.startsWith("#/components/schemas/"));
    for (const ref of schemaRefs) {
      const match = ref.match(/^#\/components\/schemas\/(.+)$/);
      expect(match, `$ref ${ref} did not match the expected pattern`).toBeTruthy();
      expect(
        schemas[match![1]],
        `$ref ${ref} is not registered in components.schemas`,
      ).toBeDefined();
    }
  });

  it("components.schemas matches the expected registered count", () => {
    // Lock the count at the current value. Bump intentionally on additions/removals.
    // 33: +1 from /reviews/{id}/action + ReviewActionBody.
    // 36: +3 from Oversight, AssignmentLadderStep, AssignmentLadder registered
    //     alongside the five missing ReviewCreateBody fields.
    const schemas = openApiDocument.components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBe(36);
  });

  it("paths contain the expected total operationId count", () => {
    // Counts only HTTP method keys (get/post/put/delete/patch/etc.), not
    // path-level keys like `parameters`. Result matches the 31 operationIds
    // declared in index.ts.
    // 31: +1 from /reviews/{id}/action + ReviewActionBody.
    const ops = Object.values(openApiDocument.paths).flatMap((p) =>
      Object.keys(p as Record<string, unknown>).filter((k) => HTTP_METHODS.has(k)),
    );
    expect(ops.length).toBe(31);
  });
});

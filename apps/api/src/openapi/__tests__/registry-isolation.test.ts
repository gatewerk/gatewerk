import { describe, it, expect } from "vitest";
import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry";
// side-effect: registers all Zod schemas with the central OpenAPIRegistry
import "../components/schemas/reviews";
import "../components/schemas/shared";
import "../components/schemas/templates";
import "../components/schemas/reports";

// Schema definitions in @asteasolutions/zod-to-openapi v8 carry
// {type: "schema", schema: ZodType} — the name is embedded as openapi()
// metadata on the Zod schema, not as a top-level definition key. The
// canonical count of DISTINCT schema names is therefore the number of
// entries in the generated components.schemas map (36),
// which also equals the total number of schema-type definitions registered.
// 36: +3 from Oversight, AssignmentLadderStep, AssignmentLadder registered
//     alongside the five missing ReviewCreateBody fields.

describe("OpenAPIRegistry state after side-effect imports", () => {
  it("contains the expected schema count", () => {
    const schemaDefs = registry.definitions.filter(
      (d) => d.type === "schema",
    );
    expect(schemaDefs).toHaveLength(36);
  });

  it("contains no duplicate schema definitions (definition count matches schema count)", () => {
    // In zod-to-openapi v8, each registry.register() call appends one
    // {type:"schema"} entry. Duplicate registrations would inflate this
    // count above the number of distinct generated components.schemas keys.
    // Both should be 36.
    const schemaDefs = registry.definitions.filter(
      (d) => d.type === "schema",
    );
    // All definitions should be type "schema" — no unexpected types.
    const otherDefs = registry.definitions.filter(
      (d) => d.type !== "schema",
    );
    expect(otherDefs).toHaveLength(0);
    // Total should equal the expected schema count.
    expect(schemaDefs.length).toBe(36);
  });

  it("no library-side dedupe between registrations and generated output", () => {
    // Asserts: the registry's schema-typed definition count equals the
    // count of schemas in the generated OpenAPI components. If the library
    // were to silently dedupe by name (e.g., last-write-wins), this would
    // mask a duplicate registration in a side-effect import.
    const generator = new OpenApiGeneratorV31(registry.definitions);
    const generated = generator.generateComponents();
    const generatedSchemaCount = Object.keys(generated.components?.schemas ?? {}).length;
    const registeredSchemaCount = registry.definitions.filter(
      (d) => d.type === "schema",
    ).length;
    expect(generatedSchemaCount).toBe(registeredSchemaCount);
  });
});

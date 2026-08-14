/**
 * Library type gap: @asteasolutions/zod-to-openapi's OpenAPIMetadata type
 * does not declare `const`. This helper preserves correct OAS 3.1 runtime
 * output (emits `type: "string", const: "X"`) while keeping type-safety.
 *
 * Replaces `.openapi({ type: "string", const: "X" } as any)` call sites with
 * `.openapi(constLiteral("X"))`.
 */
export function constLiteral<T extends string>(value: T) {
  return { type: "string" as const, const: value };
}

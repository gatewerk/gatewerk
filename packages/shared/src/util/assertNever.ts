/**
 * Compile-time exhaustiveness check for discriminated unions.
 *
 * Used in switch statements over discriminated unions: place
 * `return assertNever(x)` (or `throw assertNever(x)`) in the default branch.
 * If a new variant is added to the union without updating the switch,
 * TypeScript rejects the call at compile time because `x` is no longer `never`.
 *
 * Throws at runtime if reached — but the typical path is for TypeScript to
 * prevent the call from compiling in the first place.
 */
export function assertNever(x: never): never {
  throw new Error("Unreachable: " + JSON.stringify(x));
}

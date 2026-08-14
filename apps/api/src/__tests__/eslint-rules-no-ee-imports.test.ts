import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
// Rule lives at repo root /eslint-rules/no-ee-imports.mjs
// @ts-ignore — plain .mjs has no declaration file; rule shape verified by RuleTester at runtime.
import rule from "../../../../eslint-rules/no-ee-imports.mjs";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser as any,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
});

describe("no-ee-imports", () => {
  it("allows dynamic and type-only imports; blocks value imports + re-exports", () => {
    ruleTester.run("no-ee-imports", rule as any, {
      valid: [
        { name: "dynamic import allowed", code: 'await import("../ee/bootstrap");' },
        { name: "non-ee path ignored", code: 'import { x } from "./local";' },
        { name: "type-only whole-import allowed", code: 'import type { Foo } from "../ee/types";' },
        { name: "per-specifier type-only allowed", code: 'import { type Foo, type Bar } from "../ee/types";' },
        { name: "non-ee re-export ignored", code: 'export { x } from "./local";' },
        { name: "type-only named re-export allowed", code: 'export type { Foo } from "../ee/types";' },
        { name: "type-only star re-export allowed", code: 'export type * from "../ee/types";' },
      ],
      invalid: [
        {
          name: "static value import blocked",
          code: 'import { foo } from "../ee/bar";',
          errors: [{ messageId: "noStaticImport" }],
        },
        {
          name: "bare side-effect import blocked",
          code: 'import "../ee/side-effect";',
          errors: [{ messageId: "noStaticImport" }],
        },
        {
          name: "mixed type+value blocked",
          code: 'import { type T, x } from "../ee/mixed";',
          errors: [{ messageId: "noStaticImport" }],
        },
        {
          name: "export all blocked",
          code: 'export * from "../ee/all";',
          errors: [{ messageId: "noReexport" }],
        },
        {
          name: "export named blocked",
          code: 'export { foo } from "../ee/named";',
          errors: [{ messageId: "noReexport" }],
        },
      ],
    });
  });
});

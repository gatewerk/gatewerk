import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
// The rule lives at the repo root (shared across apps/packages), hence the
// climb out of apps/api. This test guards the extension that makes the
// rule catch the "@gatewerk/<pkg>/ee" package-subpath form (e.g.
// "@gatewerk/emails/ee") in addition to the relative "../ee/" form.
// @ts-expect-error - ESLint rule module (.mjs) ships no type declarations (TS7016)
import rule from "../../../../eslint-rules/no-ee-imports.mjs";

// Wire RuleTester to vitest's runner (vitest does not expose describe/it as
// globals in this project — tests import them explicitly).
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

ruleTester.run("no-ee-imports", rule, {
  valid: [
    // Root entry — not an EE subpath.
    `import { renderEmail } from "@gatewerk/emails";`,
    // Type-only EE subpath import erases at compile, no bundle contamination.
    `import type { TrialEndingEmailProps } from "@gatewerk/emails/ee";`,
    // Dynamic import is the sanctioned EE crossing.
    `const m = await import("@gatewerk/emails/ee");`,
    // Unrelated relative import.
    `import { foo } from "../services/foo";`,
  ],
  invalid: [
    {
      // Package EE subpath value import must be blocked from OSS src.
      code: `import { TrialEndingEmail } from "@gatewerk/emails/ee";`,
      errors: [{ messageId: "noStaticImport" }],
    },
    {
      // Existing behavior: relative EE value import stays blocked.
      code: `import { x } from "../ee/foo";`,
      errors: [{ messageId: "noStaticImport" }],
    },
    {
      // Re-export from an EE subpath leaks EE into the OSS bundle.
      code: `export { TrialEndingEmail } from "@gatewerk/emails/ee";`,
      errors: [{ messageId: "noReexport" }],
    },
  ],
});

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
// Rule lives at repo root /eslint-rules/ee-license-header.mjs
// @ts-ignore — load-bearing: rule is a plain .mjs with no .d.ts (matches the
// pattern of all existing rules in eslint-rules/). Typing the rule export
// would mean introducing TypeScript to that directory or maintaining a
// hand-written .d.ts; not worth the cost for ~30-line internal rules.
import rule from "../../../../eslint-rules/ee-license-header.mjs";

const HEADER = "// Cloud-only (EE bundle) — not built in OSS variant.";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser as any,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

describe("ee-license-header", () => {
  it("requires exact header on line 1; preserves foreign comments", () => {
    ruleTester.run("ee-license-header", rule as any, {
      valid: [
        {
          name: "file with exact header on line 1",
          code: `${HEADER}\n\nexport const x = 1;\n`,
          options: [{ header: HEADER }],
        },
        {
          name: "file with shebang + header on line 2",
          code: `#!/usr/bin/env node\n${HEADER}\n\nexport const x = 1;\n`,
          options: [{ header: HEADER }],
        },
        {
          name: "file with BOM + header (BOM stripped, header on line 1)",
          code: `﻿${HEADER}\n\nexport const x = 1;\n`,
          options: [{ header: HEADER }],
        },
      ],
      invalid: [
        {
          name: "missing header — fixer inserts at line 1",
          code: `export const x = 1;\n`,
          errors: [{ messageId: "missingHeader" }],
          output: `${HEADER}\n\nexport const x = 1;\n`,
          options: [{ header: HEADER }],
        },
        {
          name: "foreign comment on line 1 — fixer prepends, preserves foreign",
          code: `// some other comment\nexport const x = 1;\n`,
          errors: [{ messageId: "missingHeader" }],
          output: `${HEADER}\n\n// some other comment\nexport const x = 1;\n`,
          options: [{ header: HEADER }],
        },
        {
          name: "header on line 2 with no shebang — fixer reorders by prepending at line 1",
          code: `\n${HEADER}\n\nexport const x = 1;\n`,
          errors: [{ messageId: "missingHeader" }],
          output: `${HEADER}\n\n\n${HEADER}\n\nexport const x = 1;\n`,
          options: [{ header: HEADER }],
        },
        {
          name: "shebang only, no header — fixer inserts on line 2",
          code: `#!/usr/bin/env node\nexport const x = 1;\n`,
          errors: [{ messageId: "missingHeader" }],
          output: `#!/usr/bin/env node\n${HEADER}\n\nexport const x = 1;\n`,
          options: [{ header: HEADER }],
        },
        {
          name: "BOM + missing header — fixer inserts header after BOM",
          code: `﻿export const x = 1;\n`,
          errors: [{ messageId: "missingHeader" }],
          output: `﻿${HEADER}\n\nexport const x = 1;\n`,
          options: [{ header: HEADER }],
        },
      ],
    });
  });
});

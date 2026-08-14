import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import noReviewNotesImports from "./eslint-rules/no-review-notes-imports.mjs";
import noBareTargetDelete from "./eslint-rules/no-bare-target-delete.mjs";
import noEeImports from "./eslint-rules/no-ee-imports.mjs";
import eeLicenseHeader from "./eslint-rules/ee-license-header.mjs";

// Modular architecture guardrail.
// 600-line hard cap, error-level. Soft 400 target is reviewer-enforced, not linted.
// Exemptions: test files, generated files, SDK packages, type declarations (spec §6 locked decisions).

const MAX_LINES = 600;

// Phase A notes-layer guardrails (Task 22). Both rules are scoped to apps/api
// only — packages/db owns the schema modules and no frontend has direct
// drizzle access. The helper itself (services/note-cleanup.ts) is file-glob
// exempt below because its dynamic dispatch through TARGET_TABLES looks
// identical to a bare delete at the AST level.
const gatewerkPlugin = {
  rules: {
    "no-review-notes-imports": noReviewNotesImports,
    "no-bare-target-delete": noBareTargetDelete,
    "no-ee-imports": noEeImports,
    "ee-license-header": eeLicenseHeader,
  },
};

export default [
  {
    name: "gatewerk/global-ignores",
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      // The cloud typecheck profile (ee/api/tsconfig.json) emits here. It is
      // gitignored inside the submodule, but a developer who has run
      // `pnpm build:cloud` would otherwise lint a compiled copy of every EE
      // and API source file.
      "**/dist-cloud/**",
      "**/build/**",
      "**/.react-router/**",
      "**/.vite/**",
      "**/.turbo/**",
      "**/coverage/**",
      "prototype/**",
      "**/*.d.ts",
      // docs/ is gitignored (specs, audits, research). Ad-hoc .ts/.tsx
      // fixtures inside audit reports otherwise hit the project's TS parser
      // and surface as parsing errors that don't represent app code.
      "docs/**",
      // SDK packages out of scope per spec §6 locked decisions.
      "packages/sdk-ts/**",
      "packages/sdk-py/**",
      "packages/mcp/**",
      "packages/n8n-nodes-gatewerk/**",
      // Email templates are display-layer files; no business-logic line cap applies.
      "packages/emails/**",
      // The Cloud dunning templates, same display-layer reasoning. They moved
      // out of packages/emails into the private submodule and would otherwise
      // match no TS-parser block and fail to parse. Their Cloud-only license
      // header is enforced by ee/emails/templates/license-header.test.ts, not
      // by the eslint rule, exactly as it was before the move.
      "ee/emails/**",
      // Site package — Astro/Starlight marketing + docs; out of scope for app-code rules.
      "site/**",
    ],
  },
  {
    name: "gatewerk/in-scope-typescript",
    files: [
      "apps/web-next/src/**/*.ts",
      "apps/web-next/src/**/*.tsx",
      // Same reason as apps/web/ee above: without these globs the cloud bundle
      // matches no TS-parser config and goes silently unlinted, while its
      // *.test.ts lands in the tests-exempt block and fails to parse as JS.
      "ee/web-next/**/*.ts",
      "ee/web-next/**/*.tsx",
      "apps/api/src/**/*.ts",
      // The EE trees moved to the private ./ee submodule. These globs match
      // nothing on a clone without --recurse-submodules, which is the
      // supported OSS state — eslint simply has less to lint.
      "ee/api/**/*.ts",
      "packages/shared/src/**/*.ts",
      "packages/db/src/**/*.ts",
      // The API client, pure libs, hooks and framework-free screen state that
      // both frontends share. Extracted from apps/web; it carries .tsx
      // (context providers), so both extensions are listed or those files
      // match no TS-parser block and fail to parse.
      "packages/web-core/src/**/*.ts",
      "packages/web-core/src/**/*.tsx",
    ],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      "max-lines": [
        "error",
        { max: MAX_LINES, skipBlankLines: true, skipComments: true },
      ],
      // Enforced at error. Every currently-extant violation has an adjacent
      // `eslint-disable-next-line` directive with a load-bearing rationale
      // documenting why exhaustive-deps is wrong for that specific call site.
      // New violations without rationale fail CI.
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    name: "gatewerk/api-notes-layer-rules",
    files: ["apps/api/src/**/*.ts"],
    plugins: { gatewerk: gatewerkPlugin },
    rules: {
      "gatewerk/no-review-notes-imports": "error",
      "gatewerk/no-bare-target-delete": "error",
    },
  },
  {
    name: "gatewerk/api-notes-layer-rules-helper-exempt",
    files: ["apps/api/src/services/note-cleanup.ts"],
    rules: {
      // The helper's dynamic dispatch through TARGET_TABLES[kind] looks
      // identical to a bare delete at the AST level; this is the canonical
      // call site, exempted by file glob rather than inline disable comment.
      "gatewerk/no-bare-target-delete": "off",
    },
  },
  {
    name: "gatewerk/ee-boundary",
    files: ["apps/api/src/**/*.ts"],
    plugins: { gatewerk: gatewerkPlugin },
    rules: {
      "gatewerk/no-ee-imports": "error",
    },
  },
  {
    name: "gatewerk/ee-license-header",
    files: ["ee/api/**/*.ts"],
    plugins: { gatewerk: gatewerkPlugin },
    rules: {
      "gatewerk/ee-license-header": [
        "error",
        { header: "// Cloud-only (EE bundle) — not built in OSS variant." },
      ],
    },
  },
  {
    // Phase A spec §10: notes-module files use a tighter 300-line cap than
    // the project default (600). The module is small by design (CRUD +
    // attachments + tags + visibility helper + caps + cleanup) — drift past
    // 300 means a missing extraction, not just bigger handlers. Last-match-
    // wins ordering is critical: this block must come AFTER in-scope-
    // typescript's max-lines: 600 setting and BEFORE tests-exempt's
    // max-lines: off so test files in __tests__/ stay fully exempt.
    name: "gatewerk/notes-module-300-line-cap",
    files: [
      "apps/api/src/routes/notes/**/*.ts",
      "apps/api/src/services/notes-*.ts",
      "apps/api/src/services/note-cleanup.ts",
      "apps/web-next/src/screens/notes/**/*.ts",
      "apps/web-next/src/screens/notes/**/*.tsx",
      // Moved out of apps/web/src/api with the web-core extraction. The cap
      // follows the file, otherwise the notes-layer guardrail silently stops
      // applying to the one module it was written for.
      "packages/web-core/src/api/notes.ts",
    ],
    rules: {
      "max-lines": [
        "error",
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    name: "gatewerk/tests-exempt",
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/__tests__/**/*.ts",
      "**/__tests__/**/*.tsx",
    ],
    rules: {
      "max-lines": "off",
      // Test-isolation cleanup uses bare db.delete(...) and doesn't need the
      // cascade contract — the rows being torn down are scoped to the test
      // database. The notes-layer guardrails apply to production code only.
      "gatewerk/no-bare-target-delete": "off",
      "gatewerk/no-review-notes-imports": "off",
      // ee/__tests__/ files are internal — never shipped in any bundle. The
      // license header signals bundle-isolation status (OSS vs Cloud), which
      // is meaningless for test code. Matches the max-lines / no-bare-target
      // precedent already established above for this same files glob.
      "gatewerk/ee-license-header": "off",
    },
  },
  {
    name: "gatewerk/generated-exempt",
    files: [
      "**/*.gen.ts",
      "**/*.generated.ts",
      "**/routeTree.gen.*",
      "**/+types/**",
    ],
    rules: {
      "max-lines": "off",
    },
  },
];

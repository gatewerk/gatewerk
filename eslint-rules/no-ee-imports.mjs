// eslint-rules/no-ee-imports.mjs
//
// Block static value imports + re-exports from `apps/api/ee/` in `apps/api/src/`.
// The OSS bundle MUST NOT statically reference EE modules — the only sanctioned
// crossing is the dynamic `import()` indirection in `app.ts:mountEeIfCloud`.
//
// Allowed (rule does NOT fire):
//   - `await import("../ee/foo")`              — dynamic import (bundle-isolated)
//   - `import type { X } from "../ee/foo"`     — type-only import (erased at compile)
//   - `import { type X, type Y } from "../ee/foo"` — per-specifier type-only
//   - `export type { X } from "../ee/foo"`     — type-only re-export (erased)
//   - `export type * from "../ee/foo"`         — type-only star re-export (erased)
//
// Blocked (rule DOES fire):
//   - `import { x } from "../ee/foo"`      — value import
//   - `import "../ee/foo"`                  — bare side-effect import
//   - `import { type X, y } from "../ee/foo"` — mixed type+value (any value)
//   - `export * from "../ee/foo"`           — re-export all (value)
//   - `export { x } from "../ee/foo"`       — re-export named (value)

function isEePath(src) {
  if (typeof src !== "string") return false;
  // Relative EE module: "../ee/", "../../ee/", "./ee/", any "/ee/..." segment.
  if (/(^|\/)ee\//.test(src)) return true;
  // Package EE subpath export: "@gatewerk/<pkg>/ee" (e.g. "@gatewerk/emails/ee"),
  // bare or with a trailing subpath. The leaf "/ee" has no trailing slash, so
  // the relative pattern above does not catch it.
  return /(^|\/)@gatewerk\/[^/]+\/ee(\/|$)/.test(src);
}

function isTypeOnlyImport(node) {
  if (node.importKind === "type") return true;
  if (!node.specifiers || node.specifiers.length === 0) return false;
  return node.specifiers.every((s) => s.importKind === "type");
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Block static value imports and re-exports from apps/api/ee/ in apps/api/src/. Dynamic imports and type-only imports are allowed.",
      category: "Gatewerk",
    },
    messages: {
      noStaticImport:
        "Static value import of EE module '{{path}}' is forbidden from OSS source. Use dynamic import() with function-indirection (see app.ts mountEeIfCloud).",
      noReexport:
        "Re-export from EE module '{{path}}' is forbidden in OSS source. EE re-exports leak into the OSS bundle.",
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (!isEePath(node.source.value)) return;
        if (isTypeOnlyImport(node)) return;
        context.report({
          node,
          messageId: "noStaticImport",
          data: { path: node.source.value },
        });
      },
      ExportAllDeclaration(node) {
        if (!node.source || !isEePath(node.source.value)) return;
        // `export type * from "../ee/foo"` — type-only re-export erases at
        // compile, no bundle contamination. Symmetric with the
        // ImportDeclaration type-only check above.
        if (node.exportKind === "type") return;
        context.report({
          node,
          messageId: "noReexport",
          data: { path: node.source.value },
        });
      },
      ExportNamedDeclaration(node) {
        if (!node.source || !isEePath(node.source.value)) return;
        // `export type { X } from "../ee/foo"` — type-only re-export erases
        // at compile, no bundle contamination. Symmetric with the
        // ImportDeclaration type-only check above.
        if (node.exportKind === "type") return;
        context.report({
          node,
          messageId: "noReexport",
          data: { path: node.source.value },
        });
      },
    };
  },
};

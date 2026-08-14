// eslint-rules/ee-license-header.mjs
//
// Require an exact license-marker header on line 1 of files in scope.
// Header text is passed as a rule option (no hardcoded text in the rule).
//
// Semantics:
//   - The configured header MUST match line 1 byte-for-byte (after BOM strip
//     and any shebang skip). Surrounding blank lines do not matter.
//   - If the file starts with a shebang (#!...), the header goes on line 2.
//   - If the file starts with a BOM (U+FEFF), it is stripped, then the
//     header is required on the next line.
//   - If the file has a pre-existing comment on line 1 that does NOT match,
//     the fixer INSERTS the canonical header above it (push the foreign
//     comment to line 2) — it does NOT replace foreign comments.
//
// Replaces eslint-plugin-license-header@0.9.0 which only matched comments
// containing Copyright/@license/SPDX-License-Identifier keywords — that
// regex made the plugin unusable for non-license bundle-isolation markers.

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require an exact license-marker header on line 1 of in-scope files",
      category: "Gatewerk",
    },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: {
          header: { type: "string", minLength: 1 },
        },
        required: ["header"],
        additionalProperties: false,
      },
    ],
    messages: {
      missingHeader:
        "Missing Cloud-only license header on line 1. Expected exactly: {{expected}}",
    },
  },
  create(context) {
    const opts = context.options?.[0];
    if (!opts || typeof opts.header !== "string" || opts.header.length === 0) {
      throw new Error(
        "ee-license-header: rule requires { header: string } option",
      );
    }
    const expected = opts.header;

    return {
      Program(node) {
        const sourceCode = context.getSourceCode
          ? context.getSourceCode()
          : context.sourceCode;
        const text = sourceCode.text;

        let cursor = 0;

        // BOM strip
        if (text.charCodeAt(0) === 0xfeff) cursor = 1;

        // Shebang skip
        if (text.slice(cursor, cursor + 2) === "#!") {
          const nl = text.indexOf("\n", cursor);
          cursor = nl === -1 ? text.length : nl + 1;
        }

        // Read the first line at cursor
        const nlIdx = text.indexOf("\n", cursor);
        const firstLine =
          nlIdx === -1 ? text.slice(cursor) : text.slice(cursor, nlIdx);

        if (firstLine === expected) return;

        // Report at line 1 (or first line after shebang). Insert header above
        // whatever currently occupies that position — do NOT replace foreign
        // comments.
        const loc = sourceCode.getLocFromIndex
          ? sourceCode.getLocFromIndex(cursor)
          : { line: 1, column: 0 };

        context.report({
          loc: { start: loc, end: loc },
          messageId: "missingHeader",
          data: { expected },
          fix(fixer) {
            return fixer.insertTextBeforeRange(
              [cursor, cursor],
              expected + "\n\n",
            );
          },
        });
      },
    };
  },
};

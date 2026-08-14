// Phase A spec §3.1: the `notes` + `note_attachments` tables fully supersede
// the legacy `review_notes` table. Any reference to the `reviewNotes` Drizzle
// schema identifier outside of the legacy shim is a regression — it's likely
// a copy-paste from pre-Phase-A code that should have been migrated to the
// notes layer.
//
// The shim in apps/api/src/routes/reviews/notes.ts no longer references
// reviewNotes either (it writes to `notes` + `note_attachments` per Task 18),
// so no exemption is currently needed. If a future migration helper or
// retroactive backfill needs to read review_notes, exempt that file via the
// file-glob block in eslint.config.mjs rather than disabling the rule
// inline.

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow references to the legacy reviewNotes Drizzle schema (Phase A §3.1)",
    },
    schema: [],
    messages: {
      import:
        "reviewNotes is the legacy review_notes Drizzle schema (Phase A §3.1). Use `notes` + `note_attachments` from @gatewerk/db.",
      identifier:
        "reviewNotes references the legacy review_notes table (Phase A §3.1). Use `notes` + `note_attachments` instead.",
    },
  },
  create(context) {
    return {
      ImportSpecifier(node) {
        if (node.imported && node.imported.name === "reviewNotes") {
          context.report({ node, messageId: "import" });
        }
      },
      Identifier(node) {
        if (node.name !== "reviewNotes") return;
        // ImportSpecifier already reports import-site references; skip them
        // here so we don't double-report.
        if (
          node.parent &&
          (node.parent.type === "ImportSpecifier" ||
            node.parent.type === "ImportDefaultSpecifier" ||
            node.parent.type === "ImportNamespaceSpecifier")
        ) {
          return;
        }
        context.report({ node, messageId: "identifier" });
      },
    };
  },
};

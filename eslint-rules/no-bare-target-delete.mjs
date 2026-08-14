// Phase A spec §6.6 / AC #14: every hard-delete of a target row (review,
// template, chain_run) must route through deleteWithNoteAttachments so the
// polymorphic note_attachments rows cascade in the same transaction.
//
// This rule fires on bare drizzle delete calls of the form:
//
//   db.delete(reviews).where(eq(reviews.id, id))
//
// and exempts:
//
//   1. The helper itself (services/note-cleanup.ts) — file-glob exempt in
//      eslint.config.mjs, since dynamic dispatch through TARGET_TABLES is
//      indistinguishable from a static identifier at the AST level.
//
//   2. Multi-row bulk deletes that use inArray(...) inside the where clause.
//      Bulk deletes are explicitly out of Phase A scope per the spec — the
//      Task 23 GC worker is the safety net for that path. AST-detected so
//      future bulk-delete sites are also covered without manual exemption.
//
// Inline `eslint-disable` comments are accepted only with a load-bearing
// rationale.

const TARGET_TABLES = new Set(["reviews", "templates", "chainRuns"]);

function callHasInArray(node) {
  if (!node || node.type !== "CallExpression") return false;
  if (
    node.callee &&
    node.callee.type === "Identifier" &&
    node.callee.name === "inArray"
  ) {
    return true;
  }
  for (const arg of node.arguments || []) {
    if (callHasInArray(arg)) return true;
  }
  return false;
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Force target-row deletes through deleteWithNoteAttachments (Phase A AC #14)",
    },
    schema: [],
    messages: {
      bare:
        "Bare db.delete({{name}}) bypasses deleteWithNoteAttachments. Use the helper from services/note-cleanup, or add an `inArray()` filter for an intentional bulk delete.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        // Match: <something>.delete(<TARGET_TABLE_IDENTIFIER>)
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.property.type !== "Identifier" ||
          node.callee.property.name !== "delete" ||
          node.arguments.length !== 1 ||
          node.arguments[0].type !== "Identifier" ||
          !TARGET_TABLES.has(node.arguments[0].name)
        ) {
          return;
        }
        const tableName = node.arguments[0].name;

        // Walk the chain to find the .where() CallExpression that follows.
        // The shape is: parent = MemberExpression (.where), grandparent =
        // CallExpression (.where(...)). drizzle calls always have a where —
        // a delete with no where would be a full-table wipe, which the rule
        // can flag uniformly.
        let whereCall = null;
        if (
          node.parent &&
          node.parent.type === "MemberExpression" &&
          node.parent.property.type === "Identifier" &&
          node.parent.property.name === "where" &&
          node.parent.parent &&
          node.parent.parent.type === "CallExpression"
        ) {
          whereCall = node.parent.parent;
        }

        if (whereCall && whereCall.arguments.some(callHasInArray)) {
          // Multi-row bulk pattern is the documented exemption.
          return;
        }

        context.report({
          node,
          messageId: "bare",
          data: { name: tableName },
        });
      },
    };
  },
};

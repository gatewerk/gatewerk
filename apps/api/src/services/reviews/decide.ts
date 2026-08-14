// Phase 3 of v1.4 configurable-actions (commit Block 10): the legacy
// decide / retry / cancelRequest service methods are removed. Their business
// logic moved to apps/api/src/services/reviews/{actions.ts,execute-action.ts}
// (single state-machine source of truth: invokeAction). The legacy /decide
// /retry /cancel-request HTTP routes are now thin aliases over
// executeReviewAction in apps/api/src/routes/reviews/decide.ts.
//
// This module remains as an empty slice factory because services/reviews/
// index.ts spread-merges its return into the composed service shape — keeping
// the named export prevents the import from breaking elsewhere if anything
// else (chain engine, tests) referenced the slice without going through
// findReview / individual methods. After v2.0 removes the legacy endpoints,
// this slice can be deleted entirely.

import type { AppDb } from "@gatewerk/db";

export function createReviewDecideSlice(_db: AppDb) {
  return {};
}

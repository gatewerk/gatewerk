export const PRIORITIES = ["low", "normal", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const DECISIONS = ["approved", "rejected", "edited", "retried", "expired", "max_iterations_reached", "confirmed", "vetoed"] as const;
export type Decision = (typeof DECISIONS)[number];

// Canonical review-status set after Phase 3 closure (migration 033). Storage
// holds only these five values; the API filter-param alias still accepts
// 'changes_requested' as a deprecated INPUT alias (see DEPRECATED_REVIEW_STATUSES
// + ReviewListQuerySchema below) for one minor version per spec §11.3, then
// the alias is removed in v2.0.
export const REVIEW_STATUSES = ["pending", "awaiting_iteration", "awaiting_external", "decided", "expired", "archived", "monitoring"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

// Terminal / non-terminal split — single canonical definition for the state
// machine. All polling helpers in sdk-ts and sdk-py MUST derive from these
// (or mirror them with a comment referencing this source) so a status added
// to REVIEW_STATUSES is caught in one place.
//   non-terminal: reviewer action is still pending / in-progress
//   terminal:     review is fully resolved; no further reviewer action expected
// Together they partition REVIEW_STATUSES exactly (no overlap, no gap).
export const NON_TERMINAL_REVIEW_STATUSES = [
  "pending",
  "awaiting_iteration",
  "awaiting_external",
  "monitoring",
] as const satisfies readonly ReviewStatus[];

export const TERMINAL_REVIEW_STATUSES = [
  "decided",
  "expired",
  "archived",
] as const satisfies readonly ReviewStatus[];

export function isTerminalReviewStatus(s: ReviewStatus): boolean {
  return (TERMINAL_REVIEW_STATUSES as readonly string[]).includes(s);
}

// Documents the legacy status accepted by the API filter-param alias for one
// minor version per spec §11.3. Schema-level: ReviewListQueryStatusSchema
// unions REVIEW_STATUSES with this for input parsing only. Removed in v2.0.
export const DEPRECATED_REVIEW_STATUSES = ["changes_requested"] as const;
export type DeprecatedReviewStatus = (typeof DEPRECATED_REVIEW_STATUSES)[number];

export const ACTION_KINDS = ["decision", "iteration", "side_effect"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const DECISION_VALUES = ["approved", "rejected"] as const;
export type DecisionValue = (typeof DECISION_VALUES)[number];

export const TRIGGER_PATHS = ["manual", "chain", "token", "agent"] as const;
export type TriggerPath = (typeof TRIGGER_PATHS)[number];

// Single canonical iteration status. Collapsed from the transition-period
// 2-element array post-migration-033 (storage normalization). Kept as an
// array so the ~10 migrated inArray() call sites stay unchanged —
// a single-element inArray emits the same SQL as `eq()` and removing the
// array shape would force ~10 per-site rewrites for zero functional gain.
// Single-element arrays survive when
// the alternative is broad rewrites.
export const ITERATION_STATUSES = ["awaiting_iteration"] as const;
export type IterationStatus = (typeof ITERATION_STATUSES)[number];

export function isIterationStatus(s: string): s is IterationStatus {
  return (ITERATION_STATUSES as readonly string[]).includes(s);
}

export const IRREVERSIBILITY = ["reversible", "costly_reversible", "irreversible"] as const;
export type Irreversibility = (typeof IRREVERSIBILITY)[number];

export const TIMEOUT_ACTIONS = ["auto_approve", "auto_reject", "expire"] as const;
export type TimeoutAction = (typeof TIMEOUT_ACTIONS)[number];

// HOTL monitoring gate. blocking = agent waits for the
// human decision before acting (today's only mode); monitoring = agent acts
// immediately, human may veto or confirm within the expires_at window.
// Silence auto-confirms (decided_by = 'system:monitoring_window').
export const OVERSIGHT_MODES = ["blocking", "monitoring"] as const;
export type OversightMode = (typeof OVERSIGHT_MODES)[number];

export const FIELD_TYPES = [
  "text",
  "markdown",
  "json",
  "image",
  "video",
  "number",
  "boolean",
  "select",
  "buttons",
  "date",
  "url",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

// Kept here (not in index.ts) so Zod schemas can import without creating an
// import cycle through the top-level barrel: enums must live in a leaf
// file or z.enum() receives undefined during module init.
export const SCOPES = [
  "reviews:create",
  "reviews:read",
  "reviews:decide",
  "reviews:claim",
  "reviews:assign",
  "reviews:release",
  "templates:read",
  "templates:write",
  "feedback:read",
  "audit:read",
  "stats:read",
  "notes:read",
  "notes:write",
  "notes:edit_own",
  "notes:delete_own",
  "notes:delete_any_shared",
  "notes:pin",
  "notes:unpin_any",
  // Chain run management: creating and aborting chain runs. Admin keys
  // auto-receive this (ADMIN_SCOPES = SCOPES). Non-admin API keys carrying
  // only templates:write must be re-issued with chains:create to use
  // POST /chain-runs or POST /chain-runs/:id/abort (Task 3 breaking change).
  "chains:create",
] as const;
export type Scope = (typeof SCOPES)[number];

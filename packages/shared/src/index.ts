export { VERSION } from "./_version";
export * from './notifications';
export { assertNever } from "./util/assertNever";
export {
  ENTITLEMENT_KEYS,
  EntitlementSchema,
  PLAN_IDS,
  PLAN_ENTITLEMENTS,
  type EntitlementKey,
  type BooleanEntitlementKey,
  type NumericEntitlementKey,
  type Entitlement,
  type PlanId,
} from "./entitlements";
export { generateId, parseId, isValidId, ID_PREFIXES, type ResourceType } from "./ids";
export {
  GatewerkError,
  InvalidRequestError,
  NotFoundError,
  ConflictError,
  AuthenticationError,
  ForbiddenError,
  GoneError,
  PayloadTooLargeError,
  BootError,
} from "./errors";
export { envelope, listEnvelope } from "./envelope";
export * from "./enums";
export {
  SUBSCRIPTION_PLANS,
  type SubscriptionPlan,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
  PLAN_LIMITS,
  type CloudSubscription,
} from "./cloud";
import type {
  Priority,
  Decision,
  ReviewStatus,
  Irreversibility,
  TimeoutAction,
  FieldType,
  ActionKind,
  DecisionValue,
} from "./enums";
export * from "./api";

// The template `fields[]` rule, shared so the API and the editor's Publish
// gate cannot drift. See template-validation.ts.
export { validateTemplateFields } from "./template-validation";

// The product's configuration surface, declared. Adding a knob to any request
// body in this package without tiering it here is a compile error.
export * from "./surface-tiers";

// HRP Protocol types — the single source of truth

// --- Action Configuration ---

export const ACTION_TYPES = ["approve", "reject", "request_changes"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface ActionConfig {
  type: ActionType;
  label: string;
  value: string;
}

export const DEFAULT_ACTIONS: ActionConfig[] = [
  { type: "approve", label: "Approve", value: "approve" },
  { type: "reject", label: "Reject", value: "reject" },
];

export const AUDIT_ACTIONS = [
  "review.created", "review.viewed", "review.decided", "review.retried", "review.expired",
  "review.updated", "review.auto_approved", "review.changes_requested",
  // Timeout-driven terminal outcomes. These are the transitions where no
  // human was present: the worker stamps a decision and approved_value, and
  // the agent is told to proceed. `review.auto_approved` already existed but
  // was only emitted on the auto-approve-at-creation path; the timeout path
  // emitted nothing at all, so an unattended approval left no proof in the
  // chain.
  "review.auto_rejected", "review.max_iterations_reached",
  "review.request_cancelled",
  "review.archived", "review.unarchived", "review.deleted",
  "review.bulk_archived", "review.bulk_deleted",
  "review.assignment_escalated",
  "notification.sent", "notification.failed",
  // One-click / link unsubscribe (routes/unsubscribe.ts). The route is
  // unauthenticated and identifies its subject only through a signed email
  // token, so the resolved reviewer_id is recorded and the raw token never is.
  // Tier 3 BEST_EFFORT per the audit-write contract: an unsubscribe must not
  // fail because audit_log is unavailable, and the preference row is durable.
  "notification.unsubscribed",
  "template.created", "template.updated", "template.deleted",
  "project.created", "project.updated", "settings.changed",
  "token.created", "token.consumed", "token.action_taken", "token.revoked",
  "token.extended",
  // Email-OTP recipient flow (token redesign §6.2). Per-event surface so
  // ops can reconstruct the request → verify → lock state machine from
  // audit_log alone. Emitted by routes/token-reviews.ts at each branch.
  "token.email_otp_sent",
  "token.email_otp_verified",
  "token.email_otp_wrong_email",
  "token.email_otp_failed",
  "token.email_otp_expired",
  "token.email_otp_locked",
  // Recipient session JWT cookie was present but failed verification
  // (subject mismatch, expiry, or tampering). Server evicts the cookie
  // via Set-Cookie Max-Age=0 (RFC 6265 §5.3) and emits this event so
  // ops can correlate stale-cookie traffic without joining tables.
  "token.recipient_session_invalidated",
  // Account-bound recipient flow (token redesign §6.2 + edge case E15).
  // account_login_redirect: GET /r/:token returned needs_login because no
  // main-app session was present. account_mismatch: a logged-in user did
  // not match the token's auth_user_id (edge case E15) — emitted on both
  // GET and POST /decide so ops can correlate read-only probes vs decide
  // attempts. account_decided: a successful POST /decide consumed by an
  // identity-verified account-tier session; complements the generic
  // token.consumed audit with the resolved decided_by_user_id.
  "token.account_login_redirect",
  "token.account_mismatch",
  "token.account_decided",
  // Recipient-action surface (token redesign §7 E3 + E4). Decline reverts the
  // review to pending without recording a decision; questions_raised reverts
  // the review to pending with a question note attached. Both consume the
  // token (forensic stamp via decided_by_email / decided_by_user_id by tier)
  // and emit through the same audit pipe so ops can reconstruct the recipient
  // workflow alongside decide / consume / revoke without joining tables.
  "token.declined",
  "token.questions_raised",
  // Emitted by the admin banner that surfaces manually-issued tokens which
  // expired while the parent review is still awaiting_external. Logged so
  // ops can observe banner fetch frequency and correlate with admin activity.
  "token.expired_summary_queried",
  "api_key.test_request",
  "api_key.rotated",
  // An API key IS a decision-capable principal: it can create reviews and,
  // with reviews:decide, record decisions. Its creation, its authority
  // (scopes / template_ids / is_active) and its destruction were previously
  // unattributed — the apiKeys row shows the CURRENT scopes but nothing
  // records who granted them or when. Emitted by routes/api-keys/crud.ts.
  // details carries the key PREFIX and the scope set, never the key itself.
  "api_key.created",
  "api_key.updated",
  "api_key.revoked",
  "hmac_secret.revealed", "hmac_secret.rotated",
  // Email service. System-level events
  // emitted by apps/api/src/services/email/index.ts. Every send path is
  // audit-observable so OSS operators without a provider dashboard can
  // reconstruct delivery state from audit_log alone. project_id is
  // undefined for these — they're system events, not tenant events.
  "email.send_succeeded", "email.send_failed", "email.send_skipped_no_config",
  "email.rate_limited", "email.send_deduped",
  // Admin-driven test send from Settings → Account. Distinct from production
  // sends so the audit log doesn't conflate diagnostic traffic with real
  // transactional volume; bypasses rate-limit/idempotency by design.
  "email.test_sent", "email.test_failed", "email.test_skipped_no_config",
  // Per-tenant deliverability breaker (apps/api/src/jobs/email-pause-evaluator.ts).
  // Fired once, at the moment an organization's bounce or complaint rate
  // breaches its threshold and the tenant is paused. Deliberately excludes a
  // per-send or per-skip event: those fire on every gated send afterward,
  // which would be thousands of audit rows for one decision. Resuming is a
  // human action (Task 6's admin route) and audits itself there.
  "email.tenant_paused",
  // Task 6's admin route. Fired when an admin resumes a tenant the breaker
  // paused, so the audit_log records who re enabled sending and when.
  "email.tenant_resumed",
  // Chain engine (M10). Per-step decisions still surface as review.decided;
  // these capture chain-level transitions that review audit entries don't
  // express. The chain-level rejection_policy='restart' was a v1 (M10)
  // scaffold superseded by per-step rejection policies in v2 (M13,
  // migration 023); chain.restarted has no engine emit site and was
  // removed. chain.step_rejected fires from continueToNextStep /
  // branchToStep so ops can reconstruct continue/branch chain history from
  // audit_log alone.
  "chain.created", "chain.step_materialized",
  "chain.completed", "chain.rejected", "chain.step_rejected",
  // Auth-tier invariant violation surfaced from the chain materialisation
  // path. Emitted when onReviewDecided catches an InvalidRequestError with
  // an `auth_level.*` code — the chain config is corrupt and the next step
  // cannot materialise. Step left in 'active' state for operator
  // inspection; no automatic retry (silent-failure F3 closure).
  "chain.step_halted",
  // Operator-initiated abort (Task 2). Fired when POST /chain-runs/:id/abort
  // force-stops an active run; pending/active steps are skipped atomically.
  "chain.aborted",
  // Task 3: fired when a session admin or chain owner accesses a chain step
  // they are not directly assigned to (bypass path in evaluateChainStep).
  // Includes bypass_kind ("admin"|"owner"), chain_run_id, and step_index
  // so ops can reconstruct privileged access from the audit_log alone.
  "chain.admin_bypass",
  // Daily-digest cron job. One audit event per scheduler tick so ops can
  // reconstruct whether a digest fired, was skipped (already ran today), or
  // failed at the send level — without joining jobs tables.
  "daily_digest.started",
  "daily_digest.skipped_already_ran",
  "daily_digest.send_succeeded",
  "daily_digest.send_skipped_no_config",
  "daily_digest.send_failed",
  "daily_digest.render_failed",
  "daily_digest.completed",
  "daily_digest.unhandled_error",
  // Notification-digest cron job (oss.notification-digest queue). Mirrors the
  // daily-digest audit pattern for the opted-in unread-notification roll-up.
  "notification_digest.started",
  "notification_digest.skipped_already_ran",
  "notification_digest.send_succeeded",
  "notification_digest.send_skipped",
  "notification_digest.send_failed",
  "notification_digest.render_failed",
  "notification_digest.completed",
  "notification_digest.unhandled_error",
  // Configurable-actions primitive (spec §4.5). Uniform event for all
  // action invocations — decision, iteration, side_effect kinds — produced
  // by the pure-fn dispatcher in apps/api/src/services/reviews/actions.ts
  // and persisted by the route handler. Legacy review.decided / review.retried
  // continue firing alongside for one minor version per spec §11.2.
  "review.action_taken",
  // External send-backs (Plan 6 C1). Emitted when a recipient declines a
  // review or raises questions via the token recipient-action surface.
  // Both revert the review to `pending` — they are NOT decisions and must
  // not be conflated with review.decided. Carried on SSE + outbound webhook
  // so the originating agent can observe the send-back without polling.
  "review.sent_back",
  "review.questions_raised",
  // Notes layer (Phase A). Only emitted for shared notes — private notes
  // intentionally bypass audit so they stay invisible to other reviewers.
  "note.created", "note.shared", "note.edited",
  "note.deleted", "note.pinned", "note.unpinned",
  "review.reclaimed",
  // Worker-owned revert when changes_timeout_hours has elapsed (timeout-worker tick).
  "review.changes_timeout_reverted",
  // Human workflow primitives (v1, migration 071). Claim = soft-lock by
  // a human reviewer (held_by column). Release = explicit unlock. Assigned
  // = admin reassign. Snoozed = pause until snoozed_until timestamp.
  "review.claimed",
  "review.released",
  "review.assigned",
  "review.snoozed",
  // HOTL monitoring gate: human veto / terminal confirm
  // (confirm covers BOTH human Confirm-now and system window-lapse; the
  // lapsed distinction lives in details.lapsed + the decided_by actor).
  "review.vetoed",
  "review.confirmed",
  "auth.login_success",
  "auth.login_failure",
  "auth.logout",
  "session.revoked",
  "session.revoke_all",
  "auth.lockout",
  "auth.2fa_setup",
  // POST /auth/2fa/setup writes an encrypted TOTP secret to the reviewers row
  // before any code has been confirmed. auth.2fa_setup fires only on
  // verify-setup, so an abandoned or attacker-initiated enrolment left the
  // secret on the account with nothing recording that it was planted.
  "auth.2fa_setup_started",
  "auth.2fa_disabled",
  "auth.2fa_validated",
  "auth.2fa_backup_regenerated",
  "auth.email_verified",
  "auth.password_reset_requested",
  "auth.password_reset",
  // Self-service change via POST /auth/change-password or PUT /auth/profile.
  // Deliberately NOT auth.password_reset: a reset is an out-of-band recovery
  // flow, a change is an authenticated credential rotation, and conflating
  // them would make an account takeover look like a forgotten password.
  // Both paths bump token_version and revoke every other session, so this row
  // is also the only attribution for a mass session revocation.
  "auth.password_changed",
  // PUT /auth/profile name change. Display name is the string every other
  // audit row and review renders its actor as, so a silent rename rewrites
  // how history reads.
  "profile.updated",
  "auth.login_notification_sent",
  // Emitted during login when a legacy bcrypt hash is transparently
  // re-hashed to argon2id. Fire-and-forget; does not affect login latency.
  // Enables OSS operators to monitor argon2id migration progress via
  // the audit_log surface without querying the reviewers table directly.
  "password.rehashed",
  // Emitted when the fire-and-forget argon2id rehash on login fails at the DB
  // update stage. Allows operators to identify per-user hash migration drift.
  "password.rehash_failed",
  "account.deleted",
  "account.data_exported",
  "account.avatar_updated",
  "account.avatar_removed",
  // Cloud 45-day retention purge (ee/jobs/data-cleanup.ts). The EE layer wrote
  // NOTHING to the chain, so the most irreversible operation the product
  // performs — hard-deleting every review, template, token and identity for an
  // organization — left no proof that it ran, when, or under what rule. Stripe
  // records that a subscription ended; Supabase records that a user is gone.
  // Neither records who ordered the destruction or that the retention window
  // had actually elapsed, which is the one thing you would have to defend.
  //
  // These rows land in the SYSTEM partition (project_id null) of necessity:
  // deleteOrgAppData destroys the org's projects before the org and identity
  // deletes run, so a project-partitioned row would point at nothing.
  //
  // They are also deliberately OPAQUE. anonymizeAuditLogRows runs earlier in
  // the same sequence, so anything written afterwards escapes anonymisation —
  // a proof row naming the person would reintroduce exactly the identity the
  // deletion just removed.
  "account.purged",
  // The per-org sequence is ~20 non-transactional deletes in a fixed order. A
  // failure part-way leaves the org half-deleted, and this records HOW FAR it
  // got so an operator can finish rather than guess.
  "account.purge_failed",
  // The local reviewers row holding supabase_user_id is deleted BEFORE the
  // Supabase call that needs it. If that call fails, the pointer required to
  // retry is already gone and the user's identity survives in the auth store
  // permanently. This row is the only remaining handle on that.
  "identity.deletion_failed",
  // Team management. Emitted by routes/settings/team.ts on invite issuance,
  // PUT /team/:id (role / name / is_active change), and DELETE /team/:id
  // (soft deactivation). Required for compliance reconstruction of admin
  // privilege changes alongside hmac_secret.rotated and api_key.rotated.
  "team.invited",
  "team.updated",
  "team.removed",
  // Invite redemption (routes/invite.ts POST /:token). team.invited records
  // that an invite was ISSUED; this records that it was consumed and a new
  // reviewer principal — someone who can decide — came into existence. The
  // reviewers row alone cannot say which invite created it or who authorised it.
  "invite.redeemed",
  // Lane D passkey (WebAuthn) — credential lifecycle + auth attempts
  "passkey.registered",
  "passkey.removed",
  "passkey.login_success",
  "passkey.login_failed",
  "passkey.login_skipped_2fa",
  // Slack integration (routes/slack.ts). GET /callback is state-changing: it
  // upserts slack_workspaces and slack_user_links, which is what decides where
  // oversight DMs are delivered. Redirecting notifications to a different
  // workspace is a review-content exfiltration path, so the connect and
  // disconnect transitions need attribution. Never carries the bot token.
  "slack.connected",
  "slack.disconnected",
  // Operator-forced re-attempt of an outbound delivery
  // (routes/webhook-deliveries.ts POST /:id/retry). Tier 3 BEST_EFFORT: the
  // delivery row itself carries status / attempts / next_attempt_at, so the
  // retry stays reconstructible without this row.
  "webhook_delivery.retried",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const NOTIFICATION_EVENTS = [
  "review.created", "review.urgent", "review.assigned",
  "review.decided", "review.expired", "review.retried",
  "review.assignment_escalated",
  // Configurable-actions primitive (spec §9.1). Internal event for the
  // canonical action-taken state change. Custom iteration event names
  // (review.iteration_<id>, action.webhook_event) are outbound-only per
  // spec §9.3 and intentionally NOT in this internal bus enum — SSE
  // consumers listen to review.action_taken and inspect action_kind /
  // action_id from the payload for state-change semantics.
  "review.action_taken",
  // External send-backs (Plan 6 C1). See AUDIT_ACTIONS above for rationale.
  "review.sent_back",
  "review.questions_raised",
  // HOTL monitoring gate. Monitoring creations emit
  // monitoring_created INSTEAD of review.created so operators can mute/digest
  // high-volume monitoring without muting blocking reviews. veto_delivery_failed
  // fires when a review.vetoed webhook exhausts its retries (status='failed') —
  // the agent may not have undone the action. confirmed_delivery_failed is the
  // parity signal for review.confirmed: a lost confirm leaves the agent unable
  // to distinguish "confirmed" from "webhook lost".
  "review.monitoring_created",
  "review.vetoed",
  "review.confirmed",
  "review.veto_delivery_failed",
  "review.confirmed_delivery_failed",
  // Reminder sweep (Task 6) emits this when a review is still pending after
  // the reminder window elapses. Routed as 'oversight' by PersonalNotifier.
  "review.reminder",
  // Chain lifecycle taps (Stage 6 delta). Chain completion and rejection used
  // to reach only the outbound webhook, never the human who started the
  // chain. Emitted by chain-engine.ts and chain-rejection.ts, and only when
  // the chain was started by a reviewer, not an agent. Already mapped to
  // 'my_activity' in EVENT_CATEGORY.
  "chain.completed",
  "chain.rejected",
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

// SCOPES moved to ./enums (leaf module) so Zod schema files can import without
// causing an init-order cycle through this barrel. Re-exported via `export *
// from "./enums"` above.
import { SCOPES, type Scope } from "./enums";

export const ALL_SCOPES: Scope[] = [...SCOPES];

export const SCOPE_PRESETS = {
  agent: ["reviews:create", "feedback:read"] as Scope[],
  reviewer: ["reviews:create", "reviews:read", "reviews:decide", "templates:read", "feedback:read"] as Scope[],
  admin: [...SCOPES] as Scope[],
} as const;

// --- Core Types (HRP Protocol) ---

export interface ReviewRequest {
  template: string;
  payload: Record<string, unknown>;
  callback_url?: string;
  project?: string;
  priority?: Priority;
  actions?: string[];
  confidence?: number;
  irreversibility?: Irreversibility;
  timeout?: { action: TimeoutAction; seconds: number };
  assignee?: string;
  metadata?: Record<string, unknown>;
}

export interface ReviewResponse {
  review_id: string;
  decision: Decision;
  decided_at: string;
  edited_payload?: Record<string, unknown>;
  feedback?: string;
  reviewer?: string;
  prompt_edit?: string;
  signature?: string;
  action_value?: string;
  action_label?: string;
  auto_approved?: boolean;
}

export interface TemplateField {
  name: string;
  type: FieldType;
  label: string;
  readonly?: boolean;
  editable?: boolean;
  options?: string[]; // for select type
}

export const TEMPLATE_STATUSES = ["draft", "active", "inactive"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export interface TemplateSchema {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  fields: TemplateField[];
  // Three-shape union mirrors api/schemas/templates.ts TemplateActionsSchema:
  // legacy bare strings, legacy {type,label,value}, and
  // canonical {id,kind,...}. The API serializer normalizes wire responses to
  // canonical (spec §11.2), but this hand-maintained interface tolerates all
  // three because consumers may receive cached/in-flight responses from any
  // tier of the transition. Use `actions` with a runtime shape check (`typeof
  // a === "string"`, `"id" in a`, `"type" in a`) when you need to discriminate.
  actions: string[] | ActionConfig[] | TemplateActionConfigCanonical[];
  default_priority: Priority;
  project_id: string;
  status?: TemplateStatus;
  auto_approve?: boolean;
  timeout_seconds?: number | null;
  timeout_action?: TimeoutAction | null;
  changes_timeout_hours?: number | null;
  instructions?: string | null;
  draft_config?: Record<string, unknown> | null;
  draft_updated_at?: string | null;
  chain_config?: Record<string, unknown> | null;
}

// Canonical action shape mirror — kept hand-maintained alongside the zod
// inferred TemplateActionConfig for use in TemplateSchema/TemplateMetadata.
// Any fields added to TemplateActionConfigSchema (api/schemas/templates.ts)
// should be reflected here too. See spec §3.2.
export interface TemplateActionConfigCanonical {
  id: string;
  label: string;
  description?: string;
  kind: ActionKind;
  decision_value?: DecisionValue;
  webhook_event?: string;
  requires_feedback?: boolean;
  confirmation?: boolean;
  style?: "primary" | "destructive" | "secondary" | "warning";
  icon?: string;
  order?: number;
  enabled_for_status?: ReviewStatus[];
  expose_to_recipient?: boolean;
}

// --- Template Metadata (for enriched review responses) ---

export interface TemplateMetadata {
  name: string;
  fields: TemplateFieldMeta[];
  // Same 3-shape union as TemplateSchema.actions above.
  actions: string[] | ActionConfig[] | TemplateActionConfigCanonical[];
}

export interface TemplateFieldMeta {
  name: string;
  label: string;
  type: FieldType;
  editable: boolean;
  options?: string[];
}

export interface FeedbackItem {
  review_id: string;
  template: string;
  decision: Decision;
  original_payload: Record<string, unknown>;
  suggested_value?: Record<string, unknown>;
  approved_value?: Record<string, unknown>;
  edited_payload?: Record<string, unknown>;
  was_edited?: boolean;
  feedback?: string;
  decided_at: string;
}

export interface NotificationPayload {
  event: NotificationEvent;
  review_id: string;
  template: string;
  project: string;
  priority: Priority;
  title?: string;
  url: string;
  created_at: string;
}

// --- Connections ---

export interface ConnectionConfig {
  id: string;
  name: string | null;
  description: string | null;
  key_prefix: string;
  scopes: Scope[] | null;
  template_ids: string[] | null;
  callback_url: string | null;
  default_reviewer: string | null;
  rate_limit_per_hour: number | null;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
}

export const SCOPE_LABELS: Record<Scope, string> = {
  "reviews:create": "Submit reviews",
  "reviews:read": "View reviews",
  "reviews:decide": "Decide on reviews",
  "reviews:claim": "Claim and hold reviews",
  "reviews:assign": "Reassign reviews to other reviewers",
  "reviews:release": "Release held reviews",
  "templates:read": "View templates",
  "templates:write": "Manage templates",
  "feedback:read": "Query feedback",
  "audit:read": "View audit trail",
  "stats:read": "View statistics",
  "notes:read": "View notes",
  "notes:write": "Create notes",
  "notes:edit_own": "Edit own notes",
  "notes:delete_own": "Delete own notes",
  "notes:delete_any_shared": "Delete any shared note",
  "notes:pin": "Pin notes to artifacts",
  "notes:unpin_any": "Unpin any attachment",
  "chains:create": "Create and abort chain runs",
};

// --- API Response Wrappers ---

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  has_more: boolean;
}

export interface ApiError {
  error: string;
  message: string;
  status: number;
}

// --- Multi-Tenancy ---

export const GATEWERK_MODES = ["standalone", "cloud"] as const;
export type GatewerkMode = (typeof GATEWERK_MODES)[number];

export const ORG_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

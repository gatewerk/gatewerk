/** surface-tiers/workspace — notes, team, notifications, webhooks, keys, projects, account. */
import type { AxisDeclaration } from "./types";
import type {
  NoteAxis,
  TeamAxis,
  AccountAxis,
  NotificationAxis,
  WebhookAxis,
  ApiKeyAxis,
  ProjectAxis,
} from "./axes";

// ---------------------------------------------------------------------------
// Notes — surfaced on the notes page
// ---------------------------------------------------------------------------
//
// The axes below (create/patch body, tags, is_shared, attachment targets)
// ship in the launch UI on notes-page. What remains held: review.note.content
// in ./reviews.ts — the legacy POST /reviews/:id/notes shim onto this same
// notes table — is a distinct axis and stays tier: "roadmap"; its disposition
// was not decided by this ruling and is out of scope here.

export const NOTE_AXES: Record<NoteAxis, AxisDeclaration> = {
  "create.body": { tier: "core", surface: "notes-page", group: "note" },
  "create.tags": {
    tier: "core",
    surface: "notes-page",
    group: "note",
    note: "Client-supplied taxonomy, max 10, regex-gated.",
  },
  "create.is_shared": {
    tier: "core",
    surface: "notes-page",
    group: "note",
    note: "An authorization axis, not a cosmetic one: an api_key caller that sets it false is refused with api_key_cannot_create_private.",
  },
  "create.attachments": {
    tier: "core",
    surface: "notes-page",
    group: "note",
    note: "Max 10; each element carries a settable target_kind and target_id. The picker offers templates only; review and chain run pins remain reachable through the API.",
  },
  "create.project_id": {
    tier: "request",
    note: "Required for session subjects and ignored for api_key subjects. An API-key holder CAN learn project_id — it is returned on every review object and is in the published OpenAPI schema. GET /api/v1/notes still 422s without it, so the ergonomic complaint stands; the impossibility claim does not.",
  },
  "patch.body": { tier: "core", surface: "notes-page", group: "note" },
  "patch.tags": { tier: "core", surface: "notes-page", group: "note" },
  "patch.is_shared": { tier: "core", surface: "notes-page", group: "note" },
  "patch.updated_at": {
    tier: "request",
    note: "Required optimistic-concurrency token — and unlike review update.version, this one is actually read.",
  },
  "attachment.target_kind": {
    tier: "core",
    surface: "notes-page",
    group: "pin",
    note: "review | template | chain_run.",
  },
  "attachment.target_id": { tier: "core", surface: "notes-page", group: "pin" },
};

// ---------------------------------------------------------------------------
// Team — hidden at launch
// ---------------------------------------------------------------------------

const TEAM_ROADMAP = { feature: "Teams: invite reviewers and manage roles", built: true } as const;

export const TEAM_AXES: Record<TeamAxis, AxisDeclaration> = {
  // Invites ship at launch (cutover ruling D1: a minimal Team surface, because
  // the reviewer onboarding flow needs an invite SENDER and OSS self-hosters
  // must not lose invites at the cutover). The accept page shows the invited
  // role, reversing the "role deliberately not shown" ruling whose
  // premise — "launch does not let anyone choose one" — expires with that
  // surface.
  "invite.email": { tier: "core", surface: "settings", group: "invite" },
  "invite.role": { tier: "core", surface: "settings", group: "invite" },
  // Roster + invite + remove shipped in web-next
  // (TeamPane/TeamRow). member.is_active is what DELETE /settings/team/:id
  // effectively writes (soft-delete sets is_active false) and Remove now
  // surfaces it. member.name/member.role are PUT-only (rename, role edit) —
  // that surface stays unbuilt, so both stay roadmap; TEAM_ROADMAP stays on
  // the public list through them.
  "member.name": { tier: "roadmap", roadmap: TEAM_ROADMAP },
  "member.role": {
    tier: "roadmap",
    roadmap: TEAM_ROADMAP,
    note: "The wire admits 'owner' for Cloud workspaces and reviewers_role_chk does not, so PUT /settings/team/:id dies on a Postgres check violation instead of a clean 4xx.",
  },
  "member.is_active": {
    tier: "core",
    surface: "settings",
    group: "team",
    note: "Written only via DELETE /settings/team/:id (TeamRow's Remove action, soft-delete), gated by the last-admin guard. There is no reactivate control in the UI yet — a deactivated member can only be reactivated via the API.",
  },
};

// ---------------------------------------------------------------------------
// Account preferences — NOT GATE-VERIFIABLE, see AccountAxis
// ---------------------------------------------------------------------------

export const ACCOUNT_AXES: Record<AccountAxis, AxisDeclaration> = {
  login_notifications: {
    tier: "advanced",
    surface: "settings",
    group: "account",
    note: "Has no Zod schema: hand-validated with a typeof check while its sibling key in the same body is Zod-parsed. Nothing schema-driven can see it, including this gate.",
  },
};

// ---------------------------------------------------------------------------
// Notifications, webhooks, keys, projects
// ---------------------------------------------------------------------------

export const NOTIFICATION_AXES: Record<NotificationAxis, AxisDeclaration> = {
  channels: {
    tier: "core",
    surface: "settings",
    group: "notifications",
    note: "Per-category {email, slack}. Two of the four categories map to no event and are hidden by categoriesWithEvents().",
  },
  timezone: {
    tier: "advanced",
    surface: "settings",
    group: "notifications",
    note: "RETIERED roadmap → advanced: the Delivery schedule card (web-next NotificationsPane, mounted through AccountPane into the Settings account pane) rendering a live Timezone select. The earlier retier out of the UI rested on 'null is the only reachable state once quiet hours leave the UI' — quiet hours never left this UI, so the premise was false. Its reader is quietHoursDelaySeconds.",
  },
  quiet_hours: {
    tier: "advanced",
    surface: "settings",
    group: "notifications",
    note: "RETIERED roadmap → advanced with start/end and timezone: web-next's NotificationsPane ships a quiet-hours toggle plus start/end time selects, reachable at /settings/account. The declaration said 'deliberately absent from the launch UI' while the control rendered — the drift the audit exists to catch.",
  },
  "quiet_hours.start": { tier: "advanced", surface: "settings", group: "notifications" },
  "quiet_hours.end": {
    tier: "advanced",
    surface: "settings",
    group: "notifications",
    note: "Delay-only, never a gate; capped at 12h and urgent bypasses entirely, so it can never block a notification.",
  },
  digest: {
    tier: "advanced",
    surface: "settings",
    group: "notifications",
    note: "RETIERED roadmap → advanced: the Daily digest toggle ships in NotificationsPane's Delivery schedule card. digest.at stays inert — the pane deliberately draws no time picker for it.",
  },
  "digest.enabled": { tier: "advanced", surface: "settings", group: "notifications" },
  "digest.at": {
    tier: "inert",
    note: "Zero server-side readers — the only reads are the form field and its own test. Two hardcoded 09:00 UTC crons do the sending, so a user who sets 14:00 gets 09:00 UTC.",
  },
};

export const WEBHOOK_AXES: Record<WebhookAxis, AxisDeclaration> = {
  name: { tier: "core", surface: "settings", group: "webhooks" },
  webhook_url: { tier: "core", surface: "settings", group: "webhooks" },
  events: {
    tier: "core",
    surface: "settings",
    group: "webhooks",
    note: "Free-form string[], unvalidated against any event list: a typo'd event name saves cleanly and silently never fires.",
  },
  type: { tier: "core", surface: "settings", group: "webhooks", note: "generic | slack | discord | telegram." },
  is_active: { tier: "core", surface: "settings", group: "webhooks" },
  headers: { tier: "advanced", surface: "settings", group: "webhooks" },
};

export const API_KEY_AXES: Record<ApiKeyAxis, AxisDeclaration> = {
  name: { tier: "core", surface: "settings", group: "api-keys" },
  scopes: { tier: "core", surface: "settings", group: "api-keys", note: "19 canonical scopes; 12 are enforced by a route. The 7 notes:* scopes are enforced by none." },
  description: { tier: "advanced", surface: "settings", group: "api-keys" },
  expires_at: { tier: "advanced", surface: "settings", group: "api-keys" },
  is_active: { tier: "core", surface: "settings", group: "api-keys" },
  ip_allowlist: { tier: "advanced", surface: "settings", group: "api-keys", note: "Fail-closed on malformed entries." },
  callback_url: { tier: "advanced", surface: "settings", group: "api-keys" },
  default_reviewer: { tier: "advanced", surface: "settings", group: "api-keys" },
  rate_limit_per_hour: {
    tier: "advanced",
    surface: "settings",
    group: "api-keys",
    note: "In-memory Map keyed by apiKeyId, single process — multi-replica means N times the cap.",
  },
  template_ids: {
    tier: "advanced",
    surface: "settings",
    group: "api-keys",
    note: "Constrains the template list and review creation only. It does NOT constrain chain runs or any decide-family route.",
  },
};

export const PROJECT_AXES: Record<ProjectAxis, AxisDeclaration> = {
  name: { tier: "core", surface: "settings", group: "project" },
  description: { tier: "advanced", surface: "settings", group: "project" },
  webhook_url: {
    tier: "inert",
    note: "Retiered from core — the finding this tiering exercise exists to surface. PUT /settings/project validates it, runs it through the DNS-SSRF guard and stores it — and NOTHING reads projects.webhook_url anywhere in the repo. The only webhook dispatch reads channel.webhook_url from the notification_channels table (services/notifications.ts:92), and the agent callback path is per-review callback_url (execute-action.ts). Worse, the guard's own comment at routes/settings/project.ts:83-85 asserts 'project.webhook_url is dispatched by the server when review events fire', which is false — corrected in the same commit as this retier. Operator experience if it were surfaced: paste your endpoint into Settings, save successfully, and never receive anything, with no error to explain it. On the product's single most important promise, telling the agent.",
  },
};

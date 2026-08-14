/** surface-tiers/reviews — the review write surface, mostly the caller's contract. */
import type { AxisDeclaration } from "./types";
import type { ReviewAxis } from "./axes";

// ---------------------------------------------------------------------------
// Review creation — mostly the agent's contract, not a control panel
// ---------------------------------------------------------------------------

export const REVIEW_AXES: Record<ReviewAxis, AxisDeclaration> = {
  template: { tier: "request" },
  payload: {
    tier: "request",
    note: "Undeclared keys are accepted and stored; template fields are matched only for media handling.",
  },
  priority: { tier: "request" },
  metadata: { tier: "request" },
  callback_url: { tier: "request", note: "https, DNS-SSRF validated. Required for oversight=monitoring." },
  idempotency_key: { tier: "request", note: "Unique per (project_id, key). Fixes agent node-replay duplicates." },
  trace_url: { tier: "request", note: "Deep link back to the originating agent trace." },
  irreversibility: { tier: "request", note: "Monitoring eligibility requires exactly 'reversible'." },
  assignee: {
    tier: "request",
    note: "z.string().optional() with no .min(1): assignee:'' is accepted, stored, and yields zero notification recipients.",
  },
  confidence: {
    tier: "request",
    note: "Stored and returned; no code branches on it. Left as an agent-supplied annotation rather than classified inert, because reading it back is a real use.",
  },
  timeout: {
    tier: "request",
    note: "The container is its own axis because supplying it is a policy decision: a per-review timeout owns BOTH the window and the action. Omitting it entirely is how you inherit the template's policy.",
  },
  "timeout.seconds": {
    tier: "request",
    note: "Per-review override of the template window.",
  },
  "timeout.action": {
    tier: "request",
    note: "Supplying `timeout` without `action` is a hard 422 — a per-review timeout owns the whole policy. Spec §4.1 asks whether that should relax.",
  },

  oversight: {
    tier: "roadmap",
    roadmap: { feature: "Monitoring gates: act first, human vetoes inside a window", built: true },
    note: "Works over the API today behind an 8-precondition gate. Ships in the UI after launch.",
  },
  assignment_ladder: {
    tier: "roadmap",
    roadmap: { feature: "Assignment ladders: hand a decision onward when nobody answers", built: true },
    note: "HELD. Reachable from raw HTTP and the n8n node only; no UI on any surface, so shipping ladders at launch would mean building that screen as new work rather than surfacing an existing one — the [BUILD] cost in spec §1b. Chains still ship: routing stays in the engine, and the sequence axis is the one that carries the launch story. Ladders are the escalation axis and they wait — BOTH axes are designed together so C2 extends the model instead of retrofitting it.",
  },
  "assignment_ladder.actor": {
    tier: "roadmap",
    roadmap: { feature: "Assignment ladders: hand a decision onward when nobody answers", built: true },
  },
  "assignment_ladder.trigger_after_seconds": {
    tier: "roadmap",
    roadmap: { feature: "Assignment ladders: hand a decision onward when nobody answers", built: true },
    note: "Cumulative from created_at, strictly increasing across steps.",
  },
  "assignment_ladder.status": {
    tier: "roadmap",
    roadmap: { feature: "Assignment ladders: hand a decision onward when nobody answers", built: true },
    note: "Server-owned in practice; step 0 becomes assignee and is marked active.",
  },
  max_iterations: {
    tier: "roadmap",
    roadmap: { feature: "Iteration limits and send-back SLAs", built: true },
    note: "Per-review override of the template cap.",
  },

  actions: {
    tier: "inert",
    note: "Written to reviews.actions at create and never read for authorization: execute-action re-resolves the vocabulary live from the template row by slug. n8n renders a populated multi-select for it, sends it, and the server discards it — the reviewer can still invoke every action. Whether this should become a real creation-time snapshot the way template_fields already is, is spec §4.2.",
  },

  // ── the decision itself ──
  "decide.decision": { tier: "request", note: "Narrowed in S1 to the values a caller may legitimately send: retried, expired and max_iterations_reached are server-written outcomes, and accepting them was a silent-approval path." },
  "decide.feedback": { tier: "request" },
  "decide.edited_payload": {
    tier: "request",
    note: "Gated server-side since S1 by field.editable — diff-not-filter, so a key may appear but its value may only change if the template marked that field editable.",
  },
  "decide.reviewer": {
    tier: "request",
    note: "Caller-supplied identity. S5 has a decision already made on this: with session auth the body value is ignored and the actor is whoever authenticated; with API-key auth it is recorded as details.attested_reviewer, never as actor.",
  },
  "decide.prompt_edit": { tier: "request" },
  "decide.version": { tier: "request", note: "Optional optimistic-concurrency token." },
  "decide.action_value": { tier: "request" },
  "decide.action_label": { tier: "request" },
  "veto.note": {
    tier: "request",
    note: "RETIERED roadmap → request: web-next's decision rail sends the feedback textarea as the veto note whenever a monitoring review renders its Veto button, so the axis is not absent from the UI. The gate itself stays held — nothing in the UI can CREATE a monitoring review (review.oversight and template.allow_monitoring carry the roadmap line). The only context the agent gets for an undo, so it is capped at 10k rather than the 1k used for chain notes.",
  },
  "retry.feedback": { tier: "request", note: "The send-back loop is in the launch core; this is its content." },
  "retry.prompt_edit": { tier: "request" },
  "action.action_id": { tier: "request" },
  "action.feedback": { tier: "request" },
  "action.edited_payload": { tier: "request" },
  "action.version": { tier: "request" },
  "update.payload": { tier: "request" },
  "update.version": {
    tier: "inert",
    note: "PUT /reviews/:id REQUIRES it, destructures it and passes it to the service — which then computes nextVersion from existing.current_version + 1 and never compares the caller's value to anything. A required-and-ignored concurrency token is worse than an absent one: callers believe they are protected against a lost update and they are not. Verified in services/reviews/lifecycle.ts updateVersion.",
  },
  "draft.draft_payload": { tier: "request" },

  // ── triage and bulk ──
  "bulk.ids": {
    tier: "request",
    note: "RETIERED roadmap → request: the inbox ships a select mode whose BulkBar fires bulk archive and bulk delete with the selected ids, so 'deliberately absent from the launch UI' was false. Request rather than a surfaced control for the same reason decide.decision is: a per-request body the inbox writes, not persisted configuration. The gate was fixed here: bulk archive and bulk delete were gated only on status <> 'monitoring', so a live pending review could be hard-deleted, and archiving an active chain step's review stranded the run forever.",
  },
  "note.content": {
    tier: "roadmap",
    roadmap: { feature: "Writing a note on a review through the legacy reviews endpoint", built: true },
    note: "The notes layer itself SHIPPED with the notes page, so this axis can no longer be named 'Notes: private and shared annotations' — that string was the only roadmap entry under that name, and the generator renders roadmap items as absent from the UI, which would have published 'notes are absent from the UI' on the branch that ships them. What is still held is only this door into it: POST /reviews/:id/notes, a legacy shim that writes into the same notes table and serves deprecation headers. The notes page and POST /api/v1/notes are the supported way in and are in the UI.",
  },
  // Snooze shipped on its own: the detail header's overflow
  // menu wires "Snooze 1h" against the endpoint, deliberately — its own header
  // comment records the ruling that snooze matters to a solo operator while
  // Claim/Release/Reassign are soft-locks against a colleague and wait for
  // Team. So the feature line drops "snooze" and the remaining three axes
  // carry it; snooze.until becomes a request input like decide.feedback.
  "assign.assignee": {
    tier: "roadmap",
    roadmap: { feature: "Triage: claim, release and reassign", built: true },
    note: "review.assigned is declared as a notification event, mapped to a category and offered in the webhook UI — and nothing emits it, so reassigning a review notifies nobody.",
  },
  "assign.hold": {
    tier: "roadmap",
    roadmap: { feature: "Triage: claim, release and reassign", built: true },
  },
  "snooze.until": {
    tier: "request",
    note: "RETIERED roadmap → request: the inbox detail header ships a 'Snooze 1h' menu item that writes a fixed now+1h value; no UI offers an arbitrary time. No clamp: a past value is a no-op and '3000-01-01' is a permanent disarm. Honoured in exactly 2 of the 7 worker sweeps, and deliberately refused for monitoring — you cannot pause a real-world undo deadline.",
  },
  "claim.force": {
    tier: "roadmap",
    roadmap: { feature: "Triage: claim, release and reassign", built: true },
    note: "Query param, not a body key. Overrides another reviewer's soft-lock and needs reviews:assign. No decision path references held_by at all, so the lock advises rather than enforces.",
  },
};

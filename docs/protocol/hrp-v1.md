# Human Review Protocol (HRP) v1: Draft Specification

> Status: Draft
> Date: 2026-03-09
> Published: 2026-08-14
> License: Apache 2.0
> Implemented by: Gatewerk

## Preamble

HRP standardizes the point in an agent pipeline where work stops for a
human decision. An agent can draft, execute, route, and carry;
responsibility for what the work does in the world stays with a person.
The protocol makes that handoff explicit: a structured request from an
agent, a decision from a human, and a record that the decision happened.

Two consequences shape the specification.

**The spec is framework agnostic.** The handoff is defined by humans and
decisions, not by any agent framework, model vendor, or orchestration
stack. A review mechanism that lives inside one framework can only pause
that framework's workflows, and the actions that need review come from
all of them. HRP therefore defines transport level messages that any
system able to make an HTTP request can emit, and any conforming station
can receive.

**Decision points are designed by a human and decided by a human.** A
person authors the template that defines where review enters a pipeline
and what the reviewer sees. A person makes the decision. The protocol has
no mechanism for a model to answer a Review Request: a Review Response
records human judgment, or, under a timeout policy, records explicitly
that no human decided. A station that lets software impersonate a
reviewer does not conform.

## Overview

The Human Review Protocol (HRP) defines a standard for AI agents to request a human decision (review, edit, or feedback) in a framework-agnostic, transport-agnostic way.

HRP fills a gap in the existing protocol landscape:
- **MCP** (Anthropic) standardizes Agent ↔ Tool communication
- **A2A** (Google) standardizes Agent ↔ Agent communication
- **HRP** standardizes **Agent ↔ Human** communication

## Design Goals

1. **Framework-agnostic**: works with LangGraph, CrewAI, custom Python, bash scripts, anything
2. **Transport-agnostic**: works over REST, MCP, WebSocket, or any request/response transport
3. **Simple**: a developer can implement the core protocol in an afternoon
4. **Extensible**: optional fields for advanced features (confidence, irreversibility, routing)
5. **Composable**: stations can be chained, federated, or replaced

## Terminology

| Term | Definition |
|------|-----------|
| **Agent** | Any AI system that produces output or takes actions requiring a human decision |
| **Station** | A service that implements HRP and presents reviews to humans |
| **Reviewer** | A human who reviews, approves, edits, or provides feedback |
| **Review Request** | A message from an agent to a station, requesting human input |
| **Review Response** | A message from a station back to an agent, containing the human's decision |
| **Template** | A schema that defines what fields a review form shows |

## Core Primitives

### 1. Review Request

An agent sends a Review Request when it needs a human decision.

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| `template` | string | Template identifier (defines the form schema) |
| `payload` | object | Key-value data to show to the reviewer |
| `callback_url` | string | URL to POST the decision to (webhook mode) |

**Optional fields:**

| Field | Type | Description |
|-------|------|-------------|
| `project` | string | Project/workspace identifier |
| `priority` | enum | `low`, `normal`, `high`, `critical` |
| `actions` | string[] | Available actions (default: `["approve", "reject"]`) |
| `confidence` | number (0-1) | Agent's confidence in its output |
| `irreversibility` | enum | `reversible`, `costly_reversible`, `irreversible` |
| `timeout` | object | `{ action: "auto_approve" \| "auto_reject" \| "expire", seconds: 3600 }`. Note: creating a review, not blocking on it, and treating `timeout_action: auto_approve` as an optimistic-execution pattern is superseded by `oversight: "monitoring"`, which adds the reversibility gate, honest reviewer UI, and distinct veto/confirm outcomes. `auto_approve` remains the right tool for zero-human-involvement flows. |
| `assignee` | string | Assign to specific reviewer |
| `metadata` | object | Arbitrary metadata (not shown to reviewer) |
| `oversight` | string | `"blocking"` (default) or `"monitoring"`. Since v1.6. In monitoring mode the agent proceeds immediately after the 201 and a human may veto or confirm within the window; requires `irreversibility: "reversible"`, a `callback_url`, a `timeout.seconds` window (no `timeout.action`), and a template with monitoring enabled by a human. Ineligible requests are refused 4xx with a machine-readable code. Codes: `monitoring_requires_reversible`, `monitoring_not_enabled_for_template`, `monitoring_conflicts_with_auto_approve`, `monitoring_requires_callback_url`, `monitoring_requires_timeout`, `monitoring_forbids_assignment_ladder`, `monitoring_not_supported_for_chains`. Note: supplying `timeout.action` with monitoring is rejected first at Zod schema validation (generic error at path `timeout.action`) and also produces `monitoring_forbids_timeout_action` at the route layer as defense-in-depth; it is never silently downgraded. |

**Example:**

```json
{
  "template": "proposal-review",
  "payload": {
    "proposal": "Dear hiring manager, I'm excited to apply...",
    "job_title": "Senior AI Engineer",
    "confidence": 0.82
  },
  "callback_url": "https://my-app.com/webhook/review-done",
  "project": "upwork-intel",
  "priority": "high",
  "actions": ["approve", "reject"]
}
```

### 2. Review Response

The station sends a Review Response to the agent's `callback_url` after a human decides.

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| `review_id` | string | Unique identifier of the review |
| `decision` | enum | `approved`, `rejected`, `edited`, `retried`, `expired`, `max_iterations_reached` |
| `decided_at` | string (ISO 8601) | When the decision was made |

**Optional fields:**

| Field | Type | Description |
|-------|------|-------------|
| `edited_payload` | object | Modified payload (if decision is `edited`) |
| `feedback` | string | Human's note or reason |
| `reviewer` | string | Who made the decision |
| `prompt_edit` | string | Modified prompt for retry (if decision is `retried`) |

**Example:**

```json
{
  "review_id": "rev_abc123",
  "decision": "edited",
  "edited_payload": {
    "proposal": "Dear hiring manager, I bring 5 years of experience..."
  },
  "feedback": "Made it more specific to the role",
  "reviewer": "idris@example.com",
  "decided_at": "2026-03-09T10:05:00Z"
}
```

### 3. Feedback Query

Agents can query historical decisions for self-learning.

**Request:**

```
GET /api/v1/feedback?template=proposal-review&outcome=edited&limit=10
```

**Response:**

```json
{
  "items": [
    {
      "review_id": "rev_abc123",
      "template": "proposal-review",
      "decision": "edited",
      "original_payload": { "proposal": "..." },
      "edited_payload": { "proposal": "..." },
      "feedback": "Made it more specific",
      "decided_at": "2026-03-09T10:05:00Z"
    }
  ],
  "total": 42,
  "has_more": true
}
```

### 4. Retry Request

When a reviewer requests a retry, the station notifies the agent to regenerate.

**Webhook to agent:**

```json
{
  "review_id": "rev_abc123",
  "action": "retry",
  "feedback": "Too generic, mention specific technologies",
  "prompt_edit": "Write a proposal emphasizing React and TypeScript experience..."
}
```

**Agent responds by updating the review:**

```
PUT /api/v1/reviews/rev_abc123
{
  "payload": { "proposal": "..." },
  "version": 2
}
```

The station shows the new version alongside the original.

## Chain Outcomes (since v1.7)

A chain is a route of approvers: one request, one payload, several named
humans in order, each holding it in turn. Every step is its own review, and
every step reviews the same request against the same template.

Reviews that belong to a chain are NEVER delivered as `review.decided`, and a
decision-kind action on one is never delivered as `review.action_taken`. Under
one shared template a step's approval is the same shape as the final
authorization, and the `review.decided` payload carries no chain identifier and
no step position, so nothing on that wire tells them apart. An agent keying on
`review.decided` would act after the first approver said yes and before the
last one looked. The distinction is made by withholding the event rather than
by adding a field to it, because a field only protects a receiver who already
knows to read it.

`chain.step_decided`: one step of the route decided. Carries the chain, the
step's 1-based position, the review, the verdict, who gave it, and their note.
It states no finality: `step_index` is a position and not a countdown, and
there is deliberately no `total_steps` and no `is_final`, because a step can
decide more than once under the `branch` rejection policy. Payload:
`{ "type": "chain.step_decided", "chain_run_id": "...", "step_index": 1, "review_id": "...", "decision": "approved", "decided_by": "...", "decided_at": "...", "feedback": null, "edited_payload": null, "approved_value": {...}, "action": { "id": "approve", "label": "Approve" } }`

`chain.completed`: the route authorized. This is the event to act on. It
names both ends of the run (`final_review_id`, and `initial_review_id`, which
is the review the requester was handed at creation) and carries what was
actually authorized: a chain forwards each step's approved value forward, so
after any reviewer edit the authorized object is not the payload that was
submitted.

`chain.rejected` and `chain.aborted` are the other two terminal outcomes. A
chain terminates through exactly one of these three.

**Do not wait on a step.** `chain.step_decided`, `chain.next_step_ready` and
`chain.step_rejected` are progress, not permission. Only `chain.completed`
authorizes.

Withholding `review.decided` for chain-attached reviews is a removal from the
v1 delivery contract, scoped to those reviews, introduced in v1.7. A standalone
review is unaffected and its payload is unchanged.

## Monitoring Outcomes (since v1.6)

Monitoring reviews terminate through two dedicated webhook event types.
They are NEVER delivered as `review.decided`; that payload's decision enum
is frozen.

`review.vetoed`: a human vetoed the already-executed action. The agent owns
the undo (Gatewerk is notify-only). The optional `note` is the reviewer's
context for the undo. Payload:
`{ "type": "review.vetoed", "review_id": "...", "vetoed_at": "...", "vetoed_by": "...", "note": "optional" }`

`review.confirmed`: the window closed clear. `lapsed: false` means a human
explicitly confirmed; `lapsed: true` means the window elapsed unattended,
which is absence of objection, not human sign-off. For lapses, `confirmed_at` equals
the window boundary (`expires_at`), and `decided_by` is
`"system:monitoring_window"`. Payload:
`{ "type": "review.confirmed", "review_id": "...", "confirmed_at": "...", "decided_by": "...", "lapsed": false }`

Agents MAY treat the `expires_at` returned in the 201 create response as the
moment after which no veto will arrive, with one caveat: a veto committed
before `expires_at` can still arrive late or fail delivery terminally
(bounded retry). Agents SHOULD reconcile final state via `GET /reviews/:id`
after their local window elapses rather than trusting webhook delivery alone.

On read surfaces, monitoring reviews carry `status: "monitoring"` while the
window is open and terminal `decision` values `"confirmed"` or `"vetoed"`.

## Template Schema

Templates define what the review form looks like.

```json
{
  "id": "proposal-review",
  "name": "Proposal Review",
  "description": "Review AI-generated job proposals before sending",
  "fields": [
    {
      "name": "job_title",
      "type": "text",
      "label": "Job Title",
      "readonly": true
    },
    {
      "name": "proposal",
      "type": "markdown",
      "label": "Proposal",
      "editable": true
    },
    {
      "name": "confidence",
      "type": "number",
      "label": "Confidence Score",
      "readonly": true
    }
  ],
  "actions": ["approve", "reject"],
  "default_priority": "normal"
}
```

**Field types:**

| Type | Renders As | Editable? |
|------|-----------|-----------|
| `text` | Plain text | Optional |
| `markdown` | Rendered markdown with editor | Optional |
| `json` | Formatted JSON with collapsing | Optional |
| `image` | Image preview | No |
| `number` | Numeric display | Optional |
| `boolean` | Toggle/checkbox | Optional |
| `select` | Dropdown from options list | Yes |
| `buttons` | Action buttons | Yes (selection) |

## Transport

HRP is transport-agnostic. The spec defines the message format, not the transport.

**Supported transports:**

| Transport | How It Works |
|-----------|-------------|
| **REST API** | POST to station endpoint, webhook callback |
| **MCP** | Tool calls (`request_review`, `query_feedback`) |
| **WebSocket** | Persistent connection, real-time updates |
| **Polling** | Agent polls `GET /api/v1/reviews/:id` until decided |

## Authentication

- **Agent → Station:** API key in header (`Authorization: Bearer gwk_...`)
- **Station → Agent (webhook):** HMAC-SHA256 signatures in the delivery headers. `X-Webhook-Signature` carries `sha256=<hex>`, the HMAC of the raw request body. `X-Webhook-Signature-V2` carries `t=<unix-seconds>,v1=<hex>`, where the hex is the HMAC of the timestamp and the raw body joined by a period; verifying it and enforcing freshness of `t` protects against replay.
- **Reviewer → Station:** Session-based (login) or OAuth

## Error Handling

| HTTP Status | Meaning |
|------------|---------|
| 201 | Review created successfully |
| 400 | Invalid request (missing fields, unknown template) |
| 401 | Invalid API key |
| 404 | Review or template not found |
| 409 | Review already decided (cannot modify) |
| 429 | Rate limited |

## Versioning

The protocol version is included in the URL path: `/api/v1/reviews`.

Breaking changes increment the major version. Non-breaking additions (new optional fields) do not.

One removal is scoped rather than versioned as a break: since v1.7 the station
does not send a Review Response, in either event shape, for a decision on a
review that belongs to a chain (`chain_run_id` is non-null). See Chain
Outcomes above. Integrations that do
not use chains are unaffected.

Receivers MUST tolerate unknown `decision` values and unknown webhook event
types: new outcome values may be introduced in minor versions (e.g.
`max_iterations_reached` in v1.5, `confirmed`/`vetoed` in v1.6) and surface
on read endpoints (list, feedback) org-wide regardless of whether the
receiving integration opted into the feature that produces them.

## Future Extensions (Not in v1)

These are documented for future consideration, not part of the v1 spec:

- **Authority levels:** Agent, human, institutional, regulatory
- **Review federation:** Multiple stations sharing reviews
- **Real-time collaboration:** Multiple reviewers on the same review

### Considered and rejected

Two extensions are rejected rather than deferred, because each would
have the station decide in place of a human.

- **Confidence routing:** the station would approve or reject a request
  automatically when the agent's self reported confidence crosses a
  threshold. Rejected: a Review Response records human judgment, or the
  explicit absence of one; it never records a decision derived from the
  agent's own estimate of itself. `confidence` remains an optional
  request field shown to the reviewer.
- **Progressive trust:** the station would move its own thresholds
  automatically as an agent's decision history accumulates. Rejected:
  the history is evidence for a human. Thresholds, oversight modes, and
  `auto_approve` policies are changed by human decision over the record,
  never by the station on its own.

## Reference Implementation

The reference implementation is the open-source station **Gatewerk**, available at [https://github.com/gatewerk/gatewerk](https://github.com/gatewerk/gatewerk).

Any system that implements this spec is HRP-compatible. The spec is intentionally minimal so that implementing a basic station is straightforward.

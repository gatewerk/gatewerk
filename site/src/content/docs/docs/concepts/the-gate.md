---
title: The gate
description: "A review is a typed, audited checkpoint: created by an agent, decided by a human, decision returned programmatically."
---

A **gate** is one round-trip between an AI agent and a human: the agent submits a review, a human decides it in the Inbox, and the decision comes back to the agent via webhook, polling, or SSE. Every other capability in Gatewerk (templates, chains, monitoring) composes on top of this primitive without modifying it.

## What is a review?

A review has three parts:

- **Payload**: the data the agent submitted, typed by the template's field schema. The payload is immutable after creation; edits by the reviewer produce a separate `edited_payload` that merges into `approved_value` at decision time.
- **Template**: the contract that says what fields the payload contains, which actions are available, and what the decision means. The template's field schema is snapshotted onto each review at creation time (`template_fields`) so re-publishing a template never changes how existing reviews render.
- **State**: where in the lifecycle the review currently sits (see table below).

## Which states can a review be in?

| Status | Meaning | Terminal? |
|---|---|---|
| `pending` | Awaiting a human decision in the Inbox | No |
| `awaiting_iteration` | A reviewer requested changes; the agent must resubmit | No |
| `awaiting_external` | A share link was issued; waiting for an external signer | No |
| `monitoring` | Agent has already acted; human has a veto window open | No |
| `decided` | A human (or the system) recorded a terminal decision | Yes |
| `expired` | The review timed out before a decision was recorded | Yes |
| `archived` | Soft-deleted by a user or bulk operation | Yes |

Terminal states are immutable. Once a review reaches `decided`, `expired`, or `archived`, no further action endpoints accept it.

**Decision outcomes.** When a review reaches `decided`, the `decision` field holds one of eight values: `approved`, `rejected`, `edited`, `retried`, `expired`, `max_iterations_reached`, `confirmed`, `vetoed`. The distinction between the underlying `approved`/`rejected` binary and labels like `edited` gives your feedback queries the granularity to tell "approved exactly as submitted" from "approved after the human changed something."

## What happens when two people decide at once?

Gatewerk uses first-writer-wins concurrency: the action endpoint executes `UPDATE ... WHERE current_version = <seen> RETURNING`. Pass the `current_version` you last read in the request body; if zero rows are updated the write is rejected and the caller gets a typed `ConflictError` (`version_mismatch` or `review_already_decided`). The second reviewer's client receives a specific error code and refetches the review showing the settled state. No decision is lost or double-counted.

## What happens when my agent retries?

Pass an `idempotency_key` string on `POST /api/v1/reviews`. If a review with that key already exists and is still non-terminal, the API returns the existing row with HTTP 200: your agent gets the same review ID and can poll or wait for the decision normally. If the existing row is already in a terminal state, the API returns `409 idempotency_key_terminal_conflict` so your agent knows to treat the previous decision as the answer rather than creating a new gate.

This makes LangGraph re-execution, network retries, and agent restarts safe.

## What does the API refuse?

All intake refusals are machine-readable 4xx responses with a `code` field. No request is silently downgraded. Three common intake error codes:

| Code | HTTP | Meaning |
|---|---|---|
| `template_not_found` | 404 | No template with the given slug exists in this project |
| `template_inactive` | 400 | The template exists but has been paused; no new reviews are accepted |
| `template_draft` | 400 | The template has never been published; cannot accept reviews |

There are also monitoring-specific refusals (`monitoring_requires_reversible`, `monitoring_not_enabled_for_template`, etc.) that fire when the oversight mode is `monitoring` but the template or payload does not meet the eligibility requirements.

---

See also: [Templates](/docs/concepts/templates): what a template contains and how its lifecycle works.
[Decisions and webhooks](/docs/concepts/decisions-and-webhooks): how the decision comes back to your agent.
[Chains](/docs/advanced/chains) and [External review](/docs/advanced/external-review): composition on top of the gate (pages land next).

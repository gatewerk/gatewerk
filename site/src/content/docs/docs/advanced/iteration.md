---
title: Iteration
description: How a reviewer can request changes and have the agent resubmit a revised version, with version snapshots and configurable limits.
---

Iteration is an optional layer: the core loop works without it; adding it lets a reviewer ask the agent to revise and resubmit rather than forcing an approve-or-reject binary.

## What is an iteration cycle?

When a reviewer triggers the **request changes** action (available when the template includes an `iteration` action kind), the review transitions from `pending` to `awaiting_iteration`. Gatewerk fires `review.action_taken` and `review.retried` (dual-fire, both contain the reviewer's feedback). The agent reads the feedback, produces a revised version, and resubmits.

The reviewer can also cancel a changes request (`cancel_iteration`), which reverts the review to `pending` without consuming an iteration slot.

## How does the agent resubmit?

`$REVIEW_ID` is the `id` field from the original `POST /api/v1/reviews` response (e.g. `gw_rev_...`). `$GATEWERK_API_KEY` is your agent's API key: see the [Quickstart](/docs/quickstart) for how to obtain one.

```bash
curl -X PUT https://api.gatewerk.com/api/v1/reviews/$REVIEW_ID \
  -H "Authorization: Bearer $GATEWERK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "payload": { "body": "Revised draft..." },
    "iteration_note": "Shortened the subject line per feedback"
  }'
```

The server ignores the `version` field if you send one: the next version number is always computed server-side. The review moves back to `pending` with `version` incremented. A `reviewVersions` snapshot is inserted capturing both the triggering feedback and the previous payload, so the full revision history is available in the Inbox timeline.

`iteration_count` equals `current_version - 1` everywhere in the API.

## What limits can I configure?

Two template-level fields govern limits:

| Field | Type | Effect |
|---|---|---|
| `max_iterations` | `integer \| null` | Maximum number of resubmissions allowed. When the limit is reached, the worker closes the review with `decision: "max_iterations_reached"` (system actor). If you set a `callback_url`, the webhook fires; without one, the agent must poll. |
| `changes_timeout_hours` | `integer \| null` | If the review sits in `awaiting_iteration` longer than this many hours without a resubmission, the timeout worker reverts it to `pending` and fires `review.changes_timeout_reverted`. The revert is owned by the worker tick (not the request path), so it fires on the next sweep after the deadline passes. |

Both fields default to `null` (no limit, no timeout). A review can sit in `awaiting_iteration` indefinitely if neither is set and no human intervenes.

## What can the reviewer do during awaiting_iteration?

The reviewer can save a draft while the review is in `awaiting_iteration`. Assignment ladder promotions continue to run during this period. Most other state-changing actions (veto, share, snooze) are not available on a review that is awaiting changes.

## What error codes does the resubmit endpoint return?

| Code | HTTP | Meaning |
|---|---|---|
| `review_already_decided` | 409 | Review reached a terminal state before the agent resubmitted |
| `review_expired` | 409 | Review timed out (from `expires_at`) |
| `not_awaiting_changes` | 409 | Review is in `pending` or another non-iteration state; create a new review instead |

All resubmission conflicts are exact-winner: the first write succeeds, the second gets a typed conflict code and no partial state is recorded.

---

See also: [The gate](/docs/concepts/the-gate): review states and concurrency model.
[Templates](/docs/concepts/templates): where `max_iterations` and `changes_timeout_hours` are configured.
[Decisions and webhooks](/docs/concepts/decisions-and-webhooks): the `review.retried` event shape.

---
title: Monitoring (HOTL)
description: "Reference for the monitoring oversight mode: the agent acts immediately, a human has a veto countdown, and the outcome is attributed precisely."
---

Monitoring mode is an optional oversight mode: the default gate is blocking (agent waits for a decision before acting); monitoring inverts this so the agent acts first and a human has a time-bounded veto window.

## What does monitoring mode do?

When a review is created with `oversight: "monitoring"`, the agent proceeds immediately rather than waiting. The review appears in the Inbox with a live countdown showing the remaining veto window. The human can:

- **Veto**: marks the review `vetoed`; fires `review.vetoed` to the agent's callback URL so the agent can undo the action. Gatewerk does not undo anything itself; the agent owns the reversal.
- **Confirm**: marks the review `confirmed`; fires `review.confirmed`. Ends the window early.
- **Do nothing**: when the window elapses, the TimeoutWorker closes the review as `confirmed` with `lapsed: true`, attributed to `decided_by: "system:monitoring_window"` and `decided_at: expires_at` (the window boundary, not the worker's wall clock). A lapsed window is never displayed as a human sign-off.

## What are the eligibility requirements?

All eight conditions must be met or the create request is refused with a machine-readable 4xx code: requests are never silently downgraded to blocking mode:

| Condition | Error code if violated |
|---|---|
| `oversight: "monitoring"` set in the create body | (required to trigger this mode) |
| `reversibility: "reversible"` declared in the create body | `monitoring_requires_reversible` |
| Template has `allow_monitoring: true` | `monitoring_not_enabled_for_template` |
| `callback_url` present | `monitoring_requires_callback_url` |
| `timeout_seconds` set (veto window duration) | `monitoring_requires_timeout` |
| No `auto_approve` on the template | `monitoring_conflicts_with_auto_approve` |
| No assignment ladder on the review | `monitoring_forbids_assignment_ladder` |
| Not a chain-originated review | `monitoring_not_supported_for_chains` |

## Who can veto or confirm?

Veto and confirm require a human dashboard session. API key requests to the veto and confirm endpoints return `403 human_actor_required`. This is enforced before any state check; there is no way to veto or confirm programmatically.

## What is blocked while a review is in-window?

While a review has `status: "monitoring"`, the following operations are refused:

- Snooze (`monitoring_not_snoozable`)
- Share token creation (`monitoring_not_shareable`)
- Delete and bulk delete (SQL-blocked; monitoring rows are excluded from the veto-rate denominator)
- `/action`, `/decide`, and `PUT` (version update) endpoints

Claim and reassign are permitted but cosmetic; they do not affect the countdown or the veto outcome.

## What webhooks does monitoring emit?

| Event | When |
|---|---|
| `review.monitoring_created` | Review enters monitoring state (distinct from `review.created` — separately routable) |
| `review.vetoed` | Human clicked Veto within the window |
| `review.confirmed` | Human clicked Confirm, or window lapsed (`lapsed: true` in the latter case) |
| `review.veto_delivery_failed` | Veto webhook exhausted all retry attempts (first-class alert; see below) |

## What happens if a veto delivery fails?

`review.veto_delivery_failed` is a first-class alert event delivered when all retry attempts to the agent's callback URL have been exhausted for a `review.vetoed` payload. If the agent never receives the veto notification, its action stands unreverted. Monitor for this event and have an out-of-band recovery path.

Failed `review.confirmed` deliveries do not emit an equivalent alert event: they are only visible in the Deliveries pane.

## How does the `allow_monitoring` flag work?

Setting `allow_monitoring: false` on a template (or leaving it unset) prevents any new monitoring-mode reviews from being created against that template. It does not affect reviews already in-window; those continue until they are vetoed, confirmed, or lapse.

## What do the three outcome labels mean?

The Inbox and History surfaces show three labels for monitoring-mode reviews:

- **Vetoed**: a human explicitly rejected the action in time.
- **Confirmed**: a human explicitly confirmed the action before the window closed.
- **Window elapsed**: the window lapsed; attributed to `system:monitoring_window`. These reviews are counted separately in per-template stats as the lapse rate.

Lapsed reviews are excluded from feedback memory queries by design. See [Feedback memory](/docs/advanced/feedback-memory).

---

See also: [The gate](/docs/concepts/the-gate): the `monitoring` review status and `confirmed`/`vetoed` decisions.
[Decisions and webhooks](/docs/concepts/decisions-and-webhooks): how vetoes and confirmations arrive at your agent.
[Feedback memory](/docs/advanced/feedback-memory): why lapsed reviews are excluded.

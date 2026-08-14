---
title: Assignment ladder
description: "Time-based reviewer escalation on a single review: if the assigned reviewer does not decide within a window, the review is automatically promoted to the next rung."
---

:::note[Not available at launch]
The assignment ladder is built and tested in the API, but it has no dashboard UI and no
SDK surface, so it is not part of the launch release. It is on the public roadmap. This
page documents the API-level behaviour for anyone reading the source.
:::

The assignment ladder is an optional layer: the core loop works without it; adding it auto-escalates a review up a chain of reviewers when a decision is not recorded within a configured time.

## What does the ladder do?

A ladder is a sequence of reviewer tiers defined **on the review, at creation time**. There is no template-level ladder: `assignment_ladder` is a column on the review, and templates carry no ladder field. Each tier has a `trigger_after_seconds` value counted from the original `created_at`. The TimeoutWorker evaluates ladder rungs on its 30-second tick:

1. If the current tier's window has elapsed and the review is still pending, the review is reassigned (or access is extended) to the next tier's reviewer.
2. A `review.assignment_escalated` webhook fires.
3. If the final rung elapses with no decision, the review's normal `expires_at` logic takes over.

Timers are cumulative from `created_at`. Worker jitter never compresses a tier window: a 2-hour rung is always at least 2 hours.

## Is the ladder compatible with chains?

No. Chains and the assignment ladder are mutually exclusive on the same review. If both are configured, the create endpoint returns `chain_and_ladder_exclusive`.

Per-step escalation within a chain is not available in v1.

## Example: three-tier escalation

| Rung | Reviewer | Trigger |
|---|---|---|
| 0 | alice@example.com | Immediate (step 0) |
| 1 | manager@example.com | After 2 hours |
| 2 | cto@example.com | After 4 hours |

If Alice decides within 2 hours, the ladder never advances. If not, the review is promoted to the manager at the 2-hour mark and `review.assignment_escalated` fires. If neither decides by 4 hours, the CTO is added. At `expires_at` (set independently) the review closes as `expired`.

---

See also: [Chains](/docs/advanced/chains): multi-step flows (mutually exclusive with the ladder).
[The gate](/docs/concepts/the-gate): how `expires_at` terminates reviews.

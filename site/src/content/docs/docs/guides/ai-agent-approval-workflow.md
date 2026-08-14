---
title: How do I add an approval workflow to an AI agent?
description: The options for adding human approval to an AI agent, from DIY dashboards to gate primitives, and what each requires.
---

When an AI agent takes consequential actions (sending emails, executing transactions, modifying records) teams typically want a human in the loop before the action fires. The approval workflow pattern is how that gets wired.

## What does "approval workflow" mean for an AI agent?

The general shape is: the agent produces a proposed action and pauses, a human reviews and decides, the agent proceeds or stops based on the decision. In the simplest case this is a one-time gate; in more structured systems it involves typed payloads, reviewer assignment, edit-and-retry loops, and a record of every decision.

## What does a DIY approval layer require?

The first team to need agent approvals typically builds a custom dashboard for the specific agent. The second team builds another one. By the third system, the pattern becomes internal infrastructure. A DIY approval layer has to solve:

| Problem | What it requires |
|---|---|
| **Decision races** | Two reviewers can click Approve at the same time; you need optimistic locking or last-write-wins handling so the action is taken exactly once |
| **Agent retries** | If the agent crashes and restarts, it may create a second approval request for the same action; idempotency keys prevent double approvals |
| **Edits flowing back** | The reviewer wants to correct the email subject before approving; the agent needs to receive the corrected payload, not just a boolean |
| **Provable audit trail** | Compliance asks "who approved this action, what was the payload at approval time, and was it edited?" — the record must be tamper-evident |
| **Outside reviewers** | Domain experts not in your engineering toolchain need access without an internal account or admin setup |

None of these are hard individually, but together they form an approval subsystem that every AI-powered team rebuilds from scratch.

## How does a gate primitive cover this?

A gate primitive handles the infrastructure so the agent's code handles only the decision logic. Using the [Gatewerk REST API](/docs/integrations/rest), the agent creates a review and waits for the decision:

```bash
# Agent creates a review and gets back a review ID
curl -X POST http://localhost:3100/api/v1/reviews \
  -H "Authorization: Bearer $GATEWERK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "template": "email-review",
    "payload": {
      "to": "ceo@acme.com",
      "subject": "Q4 Board Update",
      "body": "Dear Board, attached please find the Q4 report."
    }
  }'

# Agent polls for the decision (or receives it via webhook callback_url)
curl http://localhost:3100/api/v1/reviews/gw_rev_... \
  -H "Authorization: Bearer $GATEWERK_API_KEY"
```

The mapping to the problem list above:

- **Decision races**: covered by first-writer-wins optimistic locking on `current_version`; a typed `ConflictError` is returned to any second writer. See [The gate](/docs/concepts/the-gate).
- **Agent retries**: pass an `idempotency_key` on `POST /api/v1/reviews`; the same review is returned rather than creating a duplicate.
- **Edits flowing back**: the `approved_value` and `edited_payload` fields in the decision payload carry the reviewer's corrected version. See [Decisions and webhooks](/docs/concepts/decisions-and-webhooks).
- **Provable audit trail**: every decision is written to a per-project HMAC-chained audit log; the chain can be verified for tampering.
- **Outside reviewers**: the share-link (external review) feature issues a one-time token for non-account signers. See [External review](/docs/advanced/external-review).

## When do I not need this?

For single-agent, single-developer workflows where the developer is also the reviewer and the action is low-stakes, a simple email notification plus manual confirmation is sufficient. A gate primitive pays off when multiple agents or teams share a review queue, when reviewer identity and payload history need to be queryable, or when the volume of agent actions makes a custom dashboard expensive to maintain.

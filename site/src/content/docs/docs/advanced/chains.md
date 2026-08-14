---
title: Chains
description: Sequential multi-step approval flows where each step is a normal review, with per-step assignees, rejection policies, and a full transcript on completion.
---

Without chains, each review has one approver. Add a chain when a single agent submission needs to flow through a sequence of distinct human approvers before the final decision is returned.

## What is a chain?

A chain is a sequence of review steps defined in a template's `chain_config`. When a review is created on a chain-enabled template, a chain run is opened and all steps are inserted atomically. Step 1 materializes immediately as a normal pending review in the Inbox. Step 2 does not appear until step 1 is decided, and so on. Each step is a full gate: it has its own assignee, actions, and state machine.

Chains in v1 are **sequential only**. Steps run one at a time; multi-reviewer simultaneous approval is not supported.

## Who can be assigned to a step?

Each step specifies an `assignee_spec` with one of three kinds:

| Kind | Value | How it resolves |
|---|---|---|
| `user` | Email address or user ID | Review assigned to that specific user (raw-email fallback if ID not found) |
| `role` | Role name (e.g. `admin`, `reviewer`) | First user with that role to open the review claims it (first-writer-wins) |
| `external_token` **(not at launch)** | _(no extra value)_ | An external share token URL is generated for this step and included in the `chain.next_step_ready` webhook payload |

:::caution[external_token steps are not part of the launch release]
The generated link exists only inside the webhook payload, so nothing delivers it to the
recipient. `email_otp` steps additionally hard-fail when SMTP is not configured. Use
`user` or `role` assignees. External recipients are on the roadmap.
:::

Assignee PII is scrubbed from webhook payloads for future steps visible to non-privileged readers.

## What can happen when a step is rejected?

Each step has a `rejection_policy`:

| Policy | Effect |
|---|---|
| `abort` (default) | The entire chain run terminates with `chain.rejected`; all remaining steps are marked skipped |
| `continue` **(not at launch)** | The step is skipped and the next step materializes (on the last step, `continue` completes the chain) |
| `branch` **(not at launch)** | Flow jumps backward to an earlier step. Targets must point backwards — forward branches are not possible, so cycles are structurally excluded. Intermediate steps between the branch target and the current step are reset; their previous reviews are preserved in the audit trail |

:::caution[Launch ships `abort` only]
`continue` and `branch` are implemented but held back. Be aware of what `continue` means
before using it: a chain whose final step was REJECTED reports `completed`, which is the
opposite of what an oversight record should say. Both are on the roadmap.
:::

## How does payload flow between steps?

The payload an agent submits at chain creation flows forward through steps. When a reviewer edits the payload and approves, the edited version becomes the input for the next step:

```
agent_payload → step 1 reviewer → edited_payload → step 2 reviewer → approved_value → chain.completed
```

The `chain.completed` and `chain.rejected` webhooks include a full transcript of every step's decision, decision maker, feedback, and payload state.

## How do I start a chain run?

```bash
curl -X POST https://api.gatewerk.com/api/v1/chain-runs \
  -H "Authorization: Bearer $GATEWERK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "template": "proposal-review",
    "payload": { "title": "Q3 Agency Proposal", "budget": 45000 },
    "callback_url": "https://your-agent.example.com/webhook"
  }'
```

The response includes the `run_id` (`gw_chain_...`). Store it: there is no list endpoint for chain runs in v1, so an agent that loses the `run_id` has no API path to recover it.

## How do I abort a chain run?

An admin can abort an active run via `POST /api/v1/chain-runs/:id/abort`. This atomically marks the run `aborted`, skips all remaining steps, and expires any open reviews. The `chain.aborted` webhook fires. An in-progress human approval that commits after the abort returns HTTP 200 to the reviewer but is silently discarded for chain-advancement purposes; the abort wins.

## What are the chain webhooks?

| Event | When it fires |
|---|---|
| `chain.next_step_ready` | The previous step was approved and the next step's review has opened |
| `chain.step_decided` | A step decided: carries the verdict, who gave it, and their note |
| `chain.step_rejected` | A step is rejected (before abort/branch/continue resolves) |
| `chain.step_halted` | Step materialization failed (e.g. the template was deleted mid-run); the run stays active |
| `chain.completed` | The route authorized. **This is the event to act on** |
| `chain.rejected` | A step's `abort` policy terminated the run |
| `chain.aborted` | An admin aborted the run |

**A chain step never sends `review.decided`.** Every step of a route reviews the same request against the same template, so a step's approval is the same shape as the final authorization and the `review.decided` payload has no field that tells them apart. An agent keying on it would act after the first approver said yes and before the last one looked. Each step's decision arrives as `chain.step_decided` instead, and the chain authorizes with `chain.completed`.

**`step_index` is a position, not a countdown.** There is no `total_steps` and no `is_final` on a step event, deliberately: under the `branch` rejection policy a step can decide more than once, so no arithmetic on step positions can tell you a route has finished. Wait for a terminal event.

**Important:** `chain.step_halted` does not emit a terminal event. An agent waiting for `chain.completed` will wait indefinitely if a step halts. Treat `chain.step_halted` as a signal to abort. `chain.step_decided` still fires for the step whose human decided, so the decision itself is never lost.

## Are chains compatible with other layers?

Chains and the assignment ladder are mutually exclusive on the same review. Monitoring mode (`oversight: "monitoring"`) is not supported for chain-originated reviews; the create endpoint returns `monitoring_not_supported_for_chains`.

A periodic reconciliation sweep terminates chain runs stuck in an inconsistent state after a crash between step advance operations.

---

See also: [The gate](/docs/concepts/the-gate): how each step is a normal review.
[External review](/docs/advanced/external-review): external-token step assignees.
[Assignment ladder](/docs/advanced/assignment-ladder): time-based escalation within a single step (mutually exclusive with chains).

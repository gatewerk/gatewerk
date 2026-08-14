---
title: How do I make n8n wait for human approval?
description: The native n8n options for human approval pauses, what each gives you, and when a structured review gate is worth adding.
---

n8n ships several good options for pausing a workflow until a human responds. Knowing what each does is the starting point: before reaching for extra tooling.

## What does n8n give you natively?

**Wait node (webhook mode).** The Wait node pauses workflow execution and registers a webhook URL. When that URL receives a POST (from you, from another system, or from a human clicking a link), the workflow resumes. This is a general-purpose pattern: you can build an approval page that POSTs to the URL, or wire any external signal. Free on all plans including Community.

**Wait node (form mode).** The Wait node can also render a form at the webhook URL. The reviewer fills in the form and submits it; the workflow resumes with the form values. No custom HTML required, and it works on all plans.

**sendAndWait operation (Slack / Gmail / Microsoft Teams).** On Slack, Gmail, and Teams nodes, the sendAndWait operation sends a message with Approve and Decline buttons. The reviewer clicks a button in their chat client or inbox; the workflow resumes with the choice. This is the fastest path for teams already on those platforms. Free on all plans.

**Form node.** A dedicated Form node serves a multi-step form at a public URL. You can chain Form nodes for longer workflows. The submitter does not need an n8n account.

These options are genuinely useful and cover most simple approval cases. n8n designed them to be lightweight, and they are.

## What do the native options not give you?

The native options are oriented around routing a signal back into the workflow. What they do not provide:

- **Structured payload review.** The reviewer sees what you put in the Slack message or form label. If the AI agent produced a JSON payload with ten fields, there is no built-in way to display it as a typed form where the reviewer can edit specific fields and send the corrected values back downstream.
- **Audit trail of decisions.** n8n logs execution history, but there is no record of which human approved a specific item, what the payload was at decision time, whether edits were made, and what the approved version was. Compliance queries ("who approved this send, and did they change anything?") have no structured answer.
- **Reviewer accountability.** sendAndWait captures that a button was clicked, not who clicked it. If the Slack message goes to a channel, any member can approve.
- **Revision loop.** If the reviewer wants to send the item back to the agent for corrections before approving, there is no built-in iteration contract.

## A concrete scenario: editing the payload before approving

Consider a sendAndWait Slack approval for an AI-drafted outreach email. The Slack message shows a summary; the reviewer sees "Draft looks reasonable" and clicks Approve. But what if the subject line is off? The native buttons return only the choice: there is no field the reviewer can correct. The workflow resumes with the original payload unchanged, and the correction happens out-of-band (or not at all).

With a structured review gate, the reviewer opens the Inbox, edits the subject field in place, and approves the corrected version. The workflow receives the edited payload in `editedPayload` and can use it directly downstream:

```
{{ $json.editedPayload.subject ?? $json.payload.subject }}
```

No out-of-band correction. No second workflow run. The reviewer's change is in the execution record.

## How does the Gatewerk n8n node fit in?

The `n8n-nodes-gatewerk` community node uses the same webhook-wait pattern n8n's Wait node uses: the workflow pauses without blocking a worker thread. The difference is what happens at the review end: the reviewer opens the Gatewerk Inbox, sees the payload rendered by the template's field schema, can edit individual fields, and approves or rejects. The workflow resumes with the full decision payload: who decided, what the original payload was, what was edited, and when.

Add a **Gatewerk** node, set **Resource** to `Review`, leave **Operation** on its default `Request Review and Wait`, choose the seeded `email-review` template, and map your upstream fields into the payload:

```
Resource:  Review
Operation: Request Review and Wait
Template:  email-review
Payload — to:       {{ $json.to }}
Payload — subject:  {{ $json.subject }}
Payload — body:     {{ $json.body }}
Priority:       normal
```

The node creates a review via the Gatewerk API and registers n8n's internal webhook URL as the callback. Output fields include `decision`, `editedPayload`, `reviewer`, and `decidedAt`. The package is not yet published to npm, so Community Nodes install is not available yet: install manually, as described in the full integration guide at [n8n integration](/docs/integrations/n8n).

## When do I not need this?

If you are routing a yes/no decision with no payload to inspect, sendAndWait to Slack or Gmail is the right tool: it is built in and zero-setup. The structured review gate is worth adding when the payload itself needs scrutiny (the reviewer needs to read and possibly correct it), when you need a queryable record of decisions, or when reviewer identity matters for compliance. For workflows that already have a human in the authoring loop: where the agent proposes and a human edits before the workflow even runs: the gate adds friction rather than value.


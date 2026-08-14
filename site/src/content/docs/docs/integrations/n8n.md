---
title: n8n integration
description: "Add human review gates to any n8n workflow: the workflow pauses, a human decides in Gatewerk, the workflow resumes with the decision."
---

The `n8n-nodes-gatewerk` community node package adds two nodes to n8n: **Gatewerk**, an action node with a Resource and an Operation for every way to work with reviews, notes, chains, feedback, templates, audit entries, and stats, and **Gatewerk Trigger**, which starts a workflow on a Gatewerk event. The Gatewerk node's Review resource offers a Request Review and Wait operation that uses n8n's webhook-wait pattern: your workflow pauses at the node, a human reviews and decides in the Gatewerk dashboard, and the workflow resumes with the decision, the reviewer's feedback, and any payload edits, all without polling.

## How do I install it?

The `n8n-nodes-gatewerk` package publishes to npm at launch. Until then, install manually:

```bash
cd ~/.n8n/nodes
npm install /path/to/gatewerk/packages/n8n-nodes-gatewerk
```

Once published, the recommended path is **Settings > Community Nodes > Install** in your n8n instance. Enter `n8n-nodes-gatewerk`, agree to the risks, and click Install. Restart n8n if prompted.

## How do I configure it?

Create a **Gatewerk API** credential in n8n (Credentials > New > Gatewerk API):

| Field | Required | Description |
|---|---|---|
| API Key | yes | Your Gatewerk API key (starts with `gwk_`) |
| Base URL | yes | Your Gatewerk instance URL, e.g. `http://localhost:3100` |
| Webhook Secret | no | HMAC secret for signature verification on incoming decision webhooks. Without this, the node accepts any POST to its callback URL. Set it to the project's webhook secret to enable verification. |

For hosted or remote deployments, replace `http://localhost:3100` with your instance's API URL.

## Why does review creation fail with a 400?

Gatewerk validates the callback URL before it creates a review, and rejects private or reserved addresses. If your n8n instance is only reachable at a private address (localhost, a LAN address, or a Tailscale/CGNAT address in `100.64.0.0/10`), review creation fails with `HTTP 400 invalid_callback_url`. This is the most common setup failure.

Your n8n instance needs to be reachable from Gatewerk at a public address. If you are developing locally, expose n8n through a tunnel that provides a real hostname and TLS, for example ngrok or Cloudflare Tunnel.

## How do I gate my first action?

Add a **Gatewerk** node to your workflow, set **Resource** to `Review`, leave **Operation** on its default `Request Review and Wait`, and set:

- **Template**: `email-review` (the seeded template from the quickstart)
- **Payload**: map fields from previous nodes, e.g. `{{ $json.to }}`, `{{ $json.subject }}`, `{{ $json.body }}`
- **Priority**: `normal`
- **Allowed actions**: `approve`, `reject`, `edit`

Connect your Gatewerk credential in the node's credential dropdown.

When the workflow runs, the node creates a review via the Gatewerk API and passes n8n's internal webhook URL as the callback. The workflow pauses at that point.

## How does the decision come back?

The Gatewerk node's Review resource, Request Review and Wait operation, uses a true webhook wait, not polling:

1. Your workflow runs and hits the Gatewerk node.
2. The node calls `POST /api/v1/reviews` with n8n's webhook URL as the callback. n8n frees the worker thread: no worker thread or polling loop consumed while waiting.
3. A human opens the review in the Gatewerk Inbox and makes a decision.
4. Gatewerk POSTs the decision to n8n's callback URL.
5. The workflow resumes with the full decision payload available to all downstream nodes.

**Output fields from the node:**

| Field | Description |
|---|---|
| `decision` | Values include `approved`, `rejected`, `edited`, `retried`, `expired`, and others; see [The gate](/docs/concepts/the-gate) for the full enum |
| `feedback` | Free-text note from the reviewer |
| `editedPayload` | The corrected data if the reviewer edited fields |
| `reviewer` | Email of the reviewer who decided |
| `decidedAt` | ISO timestamp of the decision |

Node output fields use camelCase (`editedPayload`, `decidedAt`) per n8n convention; the equivalent REST API and SDK fields use snake_case (`edited_payload`, `decided_at`).

Use `{{ $json.editedPayload ?? $json.payload }}` in downstream nodes to get the best available version of the payload regardless of whether the reviewer edited it.

## What happens when the template has a chain?

A chain is a route of approvers: several named humans hold the same request in turn. If the template you post against defines one, the review you create becomes step 1 of a route, and it is not authorized until the last approver has decided.

Request Review and Wait handles this correctly on its shipped default, **Resume On: Decision**. It resumes on the chain terminating, never on an individual step being approved, and `$json.decision` reads `approved`, `rejected` or `aborted` for the route as a whole.

Selecting **Chain Event** additionally resumes on the intermediate step events. Do not select it if a single approval must not release your workflow: it will resume the moment the first person says yes.

## What else can it do?

The **Gatewerk** node covers every resource with a Resource and an Operation dropdown:

| Resource | Operations |
|---|---|
| **Review** | Request Review and Wait (pauses until a human decides), Create (continues immediately), Get, Get Many, Get Versions, Submit Revision (resubmit after a change request), Share Link (external review URL), Take Action (approve, reject, request changes, cancel iteration, or a custom template action) |
| **Note** | Create (optionally attached to a review, template or chain run) |
| **Chain** | Start (a multi step approval chain; does not wait, chain progression happens server side and emits per step webhooks), Get, Get for Review (the chain a given review belongs to), Abort |
| **Feedback** | Get Many (past review decisions, filtered by template and outcome, to feed learning data back to your AI nodes) |
| **Template** | Get Many |
| **Audit** | Get Many (filtered by action or review id) |
| **Stat** | Get (project stats) |

Get Many operations support limit and offset, and every returned item carries `_total` and `_hasMore` so a paging loop knows when to stop. Listing notes is not offered: that endpoint requires a project id an API key cannot supply.

The **Gatewerk Trigger** node starts a workflow on a Gatewerk event. Gatewerk cannot register the trigger's URL for you, since webhook settings are admin and session only and an API key cannot subscribe. Copy the trigger's production URL and either paste it into Gatewerk under Settings, Webhooks, or pass it as `callback_url` when a review is created, for example from a Gatewerk node with Operation set to Create.

A runnable example workflow lives in `packages/n8n-nodes-gatewerk/templates/ai-agent-with-approval.json`. Import it via **Workflows > Import from File** in n8n, then replace the `REPLACE_ME` credential id with your Gatewerk credential.

---

See also: [Quickstart](/docs/quickstart), [The gate](/docs/concepts/the-gate), [Decisions and webhooks](/docs/concepts/decisions-and-webhooks)

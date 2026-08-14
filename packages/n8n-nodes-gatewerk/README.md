# n8n-nodes-gatewerk

[n8n](https://n8n.io/) community nodes for [Gatewerk](https://github.com/gatewerk/gatewerk), the open-source review layer for AI agents. Work done for humans is decided by humans.

Your AI agent workflow pauses, a person reviews the output in a Gatewerk inbox and decides, and the workflow resumes with that decision. Reviewers can edit the payload before approving, ask for a revision and keep every iteration on one review, and every decision lands in a signed audit trail. No polling loops.

Gatewerk is open source and self-hosted, so you can have an instance running before you install this node:

```bash
git clone https://github.com/gatewerk/gatewerk.git
cd gatewerk
./scripts/quickstart.sh
```

Requires Docker and `openssl`. No account, no card. Gatewerk Cloud is available if you would rather not run it yourself.

## Nodes

The package installs two nodes.

### Gatewerk

The action node (`n8n-nodes-gatewerk.gatewerk`). Pick a **Resource** and an **Operation**; the node's parameters change to match.

The node sets `usableAsTool`. Because the Review resource offers a Request Review and Wait operation, n8n also generates a dedicated human in the loop tool, `gatewerkHitlTool`, so an AI Agent node can call it directly to pause and wait for a person. Verified working on n8n 2.6.3.

This node also adds capabilities that were not possible before: reading reviews (Get and Get Many), listing templates, checking chain run status, reading the audit trail, and reading project stats.

#### Resource: Review

- **Request Review and Wait** (`sendAndWait`, the default operation): creates a review and pauses the workflow until a human decides. Parameters: Template, Payload, Resume On, Priority, Allowed actions, Timeout action and timeout seconds, and Additional options (assignee, assignment ladder, confidence, idempotency key, irreversibility, max iterations, metadata, oversight, trace URL, wait timeout).
- **Create**: creates a review and continues immediately, without waiting for a decision. Takes the same parameters as Request Review and Wait, apart from Resume On.
- **Get**: gets a single review by its ID.
- **Get Many**: lists reviews. Optional filters: assignee, priority, status, template. Supports limit and offset. Every returned item carries `_total` and `_hasMore` so a paging loop can tell when to stop.
- **Get Versions**: the iteration history of a review.
- **Submit Revision**: resubmits a corrected payload after a reviewer asked for changes, so they can decide again. This is what closes Gatewerk's iteration loop: without it a workflow can receive a change request and never answer it.
- **Share Link**: mints an external review link so someone without a Gatewerk account can decide. Takes an expiry in hours.
- **Take Action**: invokes a configurable action, such as approve or reject, on an existing review. Parameters: Review ID, Action Name or ID (built in actions are `approve`, `reject`, `request_changes` and `cancel_iteration`; templates may define more), and Additional Fields (edited payload, feedback, version for optimistic concurrency).

**Output** (Request Review and Wait; one `main` output, one item):
- `outcome` is `approved`, `rejected`, `edited`, `expired` or `other`. Branch on this with a Switch node.
- `event` is the raw Gatewerk event name, for example `review.decided`
- `eventClass` is `decision`, `expiry`, `iteration`, `assignment`, `chain` or `unknown`
- `terminal` is true when nothing further will arrive for this review
- `decision` is present only when the event genuinely carried one, so a test for `approved` can never be fooled by an event that decided nothing
- `reviewId`, `decidedAt`, `reviewer`, `feedback`, `editedPayload`, `approvedValue`, `promptEdit`, `timeoutAction`, `iterationCount` when applicable
- `rawPayload` always carries the untouched Gatewerk body

The node has a single output rather than one per outcome. When n8n resumes a
waiting execution it hands the callback data to the node as *input* while the
node is disabled, and a disabled node forwards only the first branch, so any
extra output would silently drop every item routed to it.

**Which events resume the workflow.** A review's callback URL receives its whole
event feed, not just decisions. Sixteen event types can arrive, including
`review.sent_back`, `review.retried` and `review.action_taken`, none of which
mean a human decided anything. By default only decisions and expiries resume the
workflow. Everything else is acknowledged and the execution keeps waiting for a
real outcome. Widen this with **Resume On** if you want to react to iterations,
assignment escalations or chain events.

#### Resource: Note

Only Create is offered. `GET /api/v1/notes` requires a `project_id` query parameter that an API key cannot supply, because the key is implicitly project scoped and the key introspection endpoint does not return the project id, so listing notes would fail every time. It will be added once the API resolves that server side.

- **Create**: creates a note, optionally attached to a review or template. Parameters: Body, and Additional Fields (target kind, target ID, tags, is shared). API key callers can only create shared, project visible notes; private notes require a session credential.

#### Resource: Chain

- **Start**: starts a multi step approval chain from a chain definition and an initial payload. Set Callback URL to a Gatewerk Trigger node's production URL, otherwise the run emits no events anywhere and its progress is invisible to n8n. Chain progression happens server side and emits per step webhooks; wire a Gatewerk Trigger node to react to them.
- **Get**: gets a chain run by its ID.
- **Abort**: force-stops an active chain run and skips its remaining steps.
- **Get for Review**: gets the chain a given review belongs to.

#### Resource: Feedback

- **Get Many**: lists past review decisions, so an AI agent can learn from corrections. Optional filters: outcome, template. Supports limit and offset.

#### Resource: Template

- **Get Many**: lists templates.

#### Resource: Audit

- **Get Many**: lists audit entries. Optional filters: action, review ID (sent as resource type plus resource id, which is how review audit rows are keyed). Supports limit and offset.

#### Resource: Stat

- **Get**: gets project stats.

### Gatewerk Trigger

The trigger node (`n8n-nodes-gatewerk.gatewerkTrigger`). Starts a workflow when a Gatewerk event arrives.

Registration is manual: Gatewerk's webhook settings are admin and session only, so an API key cannot subscribe on the node's behalf. Copy the trigger's production URL from n8n and either paste it into Gatewerk's project webhook settings, or pass it as `callback_url` when creating a review, for example from the Gatewerk node's Create operation.

**Parameters:**
- Events (optional multi select; leave empty to receive every event). Options cover the fifteen named event types plus a Custom Iteration Event entry that catches operator defined iteration events, whose names are project specific and cannot be enumerated.
- Options: Include Raw Payload (on by default; include the untouched Gatewerk body as `rawPayload`)

Credentials are optional on this node. They are only used to verify the HMAC signature when a Webhook Secret is set on the credential; without one, the trigger accepts any POST to its URL.

**Output** (one `main` output, one item): the same normalised event fields the Gatewerk node's Request Review and Wait operation resumes with (`event`, `eventClass`, `outcome`, `terminal`, and, when present, `reviewId`, `chainRunId`, `decision`, `decidedAt`, `reviewer`, `feedback`, `editedPayload`, `approvedValue`, and more), since it goes through the same event classifier. Not filtered by Resume On: the trigger fires for every event that passes its own Events filter, open or terminal.

## Credentials

Configure once in n8n's credentials settings:
- **API Key**: your Gatewerk API key (starts with `gwk_`)
- **Webhook Secret** *(optional but recommended)*: HMAC secret used to verify incoming decision webhooks. Without it the node accepts any POST to its callback URL, so anyone who learns that URL can forge an approval. Set this to the project's webhook secret to enable signature verification.
- **Base URL**: your Gatewerk instance URL, for example `https://api.gatewerk.com` or `http://localhost:3100`

## Installation

### Community Nodes (recommended)

1. Go to **Settings > Community Nodes** in your n8n instance
2. Select **Install a community node**
3. Enter `n8n-nodes-gatewerk`
4. Agree to the risks and click **Install**

The package is unverified, so a self-hosted n8n needs `N8N_COMMUNITY_PACKAGES_ENABLED=true` and `N8N_UNVERIFIED_PACKAGES_ENABLED=true` before that install path appears.

### Manual Installation

For a checkout you are developing against, rather than the published package:

```bash
cd ~/.n8n/nodes
npm install /path/to/gatewerk/packages/n8n-nodes-gatewerk
```

A node installed this way loads, but n8n does not track it as a community package: **Settings > Community Nodes** shows the empty state, so it cannot be updated or uninstalled from the UI.

## Requirements

- n8n >= 1.0.0
- A running Gatewerk instance ([quick start](https://github.com/gatewerk/gatewerk#quick-start))
- A Gatewerk API key with the scopes your operations need:
  - Review Create and Request Review and Wait: `reviews:create`
  - Review Get and Get Many: `reviews:read`
  - Review Take Action: `reviews:decide`
  - Chain Start: `chains:create`
  - Chain Get and Get for Review: `reviews:read`
  - Feedback Get Many: `feedback:read`
  - Template Get Many: `templates:read`
  - Audit Get Many: `audit:read`
  - Stat Get: `stats:read`
  - Note (Create and Get Many): no scope enforced today

## Network requirements

Gatewerk validates the callback URL it POSTs decisions to, and rejects private or reserved addresses. If your n8n instance is only reachable at a private address (localhost, a LAN address, or a Tailscale/CGNAT address in `100.64.0.0/10`), review creation fails with an opaque `HTTP 400 invalid_callback_url` error. This is the most common setup failure, so check it first if reviews are not completing.

Rejected address ranges: `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `0.0.0.0/8`, `169.254.0.0/16`, `100.64.0.0/10` (this covers Tailscale addresses), and their IPv6 equivalents. DNS names are resolved and checked against these ranges too.

Your n8n instance needs to be reachable from Gatewerk at a public address for the Review resource's Request Review and Wait operation to work, since that is the operation that registers a callback URL. If you are developing locally, expose n8n through a tunnel that provides a real hostname and TLS, for example ngrok or Cloudflare Tunnel.

## How the Webhook Wait Works

The Gatewerk node's Review resource, Request Review and Wait operation, uses n8n's webhook-wait pattern:

1. Your workflow runs and hits the Gatewerk node
2. The node asks n8n for a signed resume URL, unique to this one execution, and creates a review with that URL as its callback
3. The workflow **pauses** and n8n frees the worker thread
4. A human reviews the request in the Gatewerk dashboard and makes a decision
5. Gatewerk POSTs the decision to the resume URL
6. The node classifies the event and, if it is one you asked to resume on, the workflow **resumes** with the decision available to later nodes

This is a true webhook wait, not polling. Your n8n instance uses no resources while waiting.

Because the resume URL is unique per execution, two reviews that are in flight at
the same time each resume their own workflow run. Nothing is shared between them.

Anyone who learns a resume URL could post a decision to it, so set a **Webhook
Secret** on the credential and switch **Callback Verification** to `Require`.
Gatewerk signs every delivery with HMAC, and the node then rejects anything
unsigned or altered. This is a different guarantee from the signed URL: the URL
proves the caller knows a secret address, the HMAC proves the sender is your
Gatewerk instance and the payload was not tampered with.

## Workflow Templates

Runnable example templates live in [`templates/`](./templates):

- `ai-agent-with-approval.json`: an AI agent drafts a customer reply, a human reviews it in Gatewerk, then the workflow either sends the (possibly edited) email or returns the rejection feedback.

Import a template via **Workflows → Import from File** in n8n. After import, replace the `REPLACE_ME` credential id on the Gatewerk node with your Gatewerk API credential.

## Versioning

Each node carries a `description.version` integer. The rule:

**Bump the version (and add a `versionDescription`) when you make a backward-incompatible change.** Examples that require a bump:

- Removing or renaming an existing node parameter
- Changing a parameter's `type` (e.g. `string` → `number`)
- Changing a parameter's default in a way that alters runtime behaviour for existing workflows
- Changing the shape of `execute()` output (renamed fields, removed fields, type changes)
- Changing the meaning of an enum value (e.g. `"approve"` no longer maps to "approved")

**No bump needed** for additive, opt-in changes:

- Adding a new optional parameter, for example the `webhookSecret` credential field, which is opt-in HMAC verification with no behaviour change for credentials that do not set it
- Adding new enum options (existing values still behave the same)
- Adding new fields to `execute()` output (additive only)
- Documentation changes
- Internal refactors that don't change the descriptor or output shape

When you bump the version, keep the previous version handler discoverable so existing workflows pinned to the old version continue to work. n8n's pattern is to keep `versionDescription` as an array of behaviour notes per version; reference [n8n versioning docs](https://docs.n8n.io/integrations/creating-nodes/build/reference/node-base-files/standard-parameters/#node-version) for the full lifecycle.

For credential changes, the same rule applies: optional new fields (like `webhookSecret`) ship without a version bump because old credentials remain valid; renaming or removing a credential field requires a new credential type.

## License

MIT

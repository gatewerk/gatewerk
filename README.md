# Gatewerk

**The open source review layer for AI agents.**

> One inbox where your agents' actions stop and wait for a person.
> Review the exact payload, edit it, decide. Every decision on the record.

Your AI agent drafts an email, generates a report, or initiates a
transaction. Before it reaches the real world, a human reviews it in a
structured form, edits what needs fixing, and sends the decision back.
The agent learns from what humans changed.

Works with any agent framework. Self hosted. Open source (AGPL-3.0;
client SDKs are Apache-2.0). See [LICENSING.md](LICENSING.md).

---

## Why Gatewerk?

Your agents act for you: they send the proposals, run the campaigns,
handle the invoices, write the replies. Before an action leaves the
building, a human should decide. Gatewerk is the review layer between
your agents and the real world. Human judgment enters the pipeline,
exactly where you choose.

- **Structured review forms**: not just "approve/deny", but rich templates with editable fields.
- **Feedback memory**: agents query past decisions to improve over time
- **Self hosted**: your server, your data, no SaaS dependency
- **Protocol first**: works with any agent framework via REST API, TypeScript/Python SDKs, or MCP

## Use Cases

### Before Sending
Email drafts, customer support replies, Slack messages, SMS campaigns, outreach to candidates, proposals to clients

### Before Executing
Code deployments, database migrations, financial transactions, infrastructure changes, API calls to third-party services

### Before Publishing
Blog posts, social media content, ad campaigns, product listings, documentation updates, press releases, reports

### Before Approving
Expense reports, refund requests, access permissions, contract terms, insurance claims, purchase orders

Between the gates, agents can also bring you the judgment calls: classify the edge case, pick the path, resolve the exception. Gatewerk makes human judgment callable: agents ask a structured question, you answer typed, and the pipeline continues.

## How It Works

```mermaid
sequenceDiagram
    participant Agent
    participant API as Gatewerk API
    participant Reviewer as Reviewer Dashboard
    participant Webhook as Agent via webhook

    Agent->>API: POST /reviews (template + payload)
    API->>Reviewer: Review appears in inbox
    Reviewer->>API: Approve / Reject / Edit
    API->>Webhook: Decision + edited payload
    Webhook->>Agent: Deliver decision
    Agent->>API: GET /feedback (learn from past decisions)
```

## Works With Any Agent Framework

Gatewerk is protocol-first, not framework-specific. Your agent framework already has a way to make HTTP calls or use MCP: that's all you need.

| Framework | Integration Path |
|-----------|-----------------|
| **LangChain / LangGraph** | Python SDK |
| **CrewAI** | Python SDK |
| **AutoGen / Semantic Kernel** | Python SDK |
| **OpenAI Agents SDK** | TypeScript or Python SDK |
| **Vercel AI SDK** | TypeScript SDK |
| **Claude / Cursor / Windsurf** | MCP Server |
| **n8n / Make / Zapier** | REST API + Webhooks (n8n community node published as `n8n-nodes-gatewerk`) |
| **Dify** | REST API |
| **Custom agents** | REST API, TypeScript SDK, Python SDK, or MCP |

## A review, not a yes/no ping

Without a review layer, every agent grows its own approval hack: a Slack button here, a weekend dashboard there, a shared sheet nobody audits. You end up building the same thing over and over, once per workflow. Gatewerk is that layer built once, properly:

- **Structured forms**: Reviewers see rich templates with text, markdown, JSON, images, not a yes/no dialog
- **Edit in place**: Reviewers fix the agent's output directly, not just reject it
- **Built for more than one human**: chains route multi-step approvals, reviews are claimed and reassigned, and the record shows exactly who decided what
- **Feedback loop**: Agents query past decisions via API to improve over time
- **Suggested vs Approved**: Every field tracks what the agent proposed vs what the human approved, so agents learn exactly what changed
- **Audit everything**: HMAC-signed immutable log of every action, included free
- **Your infrastructure**: Self-hosted, open source (AGPL-3.0), no vendor lock-in

## Quick Start

### 1. Start Gatewerk

Docker is the supported path. `quickstart.sh` writes a `.env` with freshly generated secrets, pulls the published images, applies migrations, seeds demo data, and waits until the API is healthy.

```bash
git clone https://github.com/gatewerk/gatewerk.git
cd gatewerk
./scripts/quickstart.sh
```

Dashboard: `http://localhost:8880`
API: `http://localhost:3100`

Requirements: Docker and `openssl`. Nothing else. The images are multi-arch, so amd64 and arm64 both pull prebuilt.

To compile the images from this checkout instead of pulling them, run `./scripts/quickstart.sh --build`.

To run the API and dashboard from source with `pnpm` and hot reload, see [Contributing](#contributing).

### 2. Log in and create an API key

Open the dashboard and log in with the seed admin account:

- Email: `admin@gatewerk.local`
- Password: `admin123`

On first login the dashboard will prompt you to change the password: pick something secure.

The seed script (`packages/db/src/seed.ts`) also creates a default project, 6 starter templates (Proposal Review, Email Review, Code Deploy, Content Approval, Expense Report, Customer Reply), and a default API key. The raw key is printed once, by the seed container. Read it back with:

```bash
docker compose logs gatewerk-seed
```

Save that key if you want to skip the next step. It starts with `gwk_`.

To create a fresh API key from the dashboard, navigate to **Settings → Project → API Keys**, click **New**, scope it for your agent, and copy the value. The raw key is shown only once. Use it wherever you see `YOUR_API_KEY` below.

### 3. Create a Template

Templates define what gets reviewed. Create one via the dashboard or API:

```bash
curl -X POST http://localhost:3100/api/v1/templates \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "quickstart-email-review",
    "name": "Email Review",
    "instructions": "Check tone and accuracy before approving.",
    "fields": [
      { "name": "subject", "type": "text", "label": "Subject", "editable": true },
      { "name": "body", "type": "markdown", "label": "Body", "editable": true },
      { "name": "recipient", "type": "text", "label": "To", "readonly": true }
    ],
    "actions": ["approve", "reject", "request_changes"],
    "default_priority": "normal",
    "timeout_seconds": 86400,
    "timeout_action": "expire",
    "auto_approve": false
  }'
```

The three action types are `approve`, `reject`, and `request_changes` (non-terminal, requires reviewer feedback). Inline editing happens automatically on any field with `"editable": true`, there is no separate "edit" action. Actions can also be declared as `{ type, label, value }` objects for custom button labels.

### 4. Send a Review Request

Both SDKs and the MCP server are published. Install them with `npm install gatewerk`, `pip install gatewerk`, or `npx @gatewerk/mcp`. No build from source required.

The two mechanisms for delivering decisions back to your agent are distinct:

- `callback_url` (per-review, used below): a one-shot HTTP destination attached to a single review. Fires the three event types documented in step 5.
- Project-level webhooks (in **Settings → Webhooks**): event subscriptions that fire across all reviews in a project. Use these when you have one agent/service receiving decisions for many reviews.

Pick one, or use both. The payload shape is identical.

**TypeScript:**

```typescript
import { createClient } from "gatewerk";

const gw = createClient({
  apiKey: "gwk_...",
  url: "http://localhost:3100",
});

const { data, error } = await gw.reviews.create({
  template: "quickstart-email-review",
  payload: {
    subject: "Q1 Report",
    body: "Revenue grew 23% YoY...",
    recipient: "ceo@company.com",
  },
  callback_url: "https://example.com/webhook",
  priority: "high",
});
```

**Python:**

```python
from gatewerk import create_client

gw = create_client(api_key="gwk_...", url="http://localhost:3100")

review = gw.reviews.create(
    template="quickstart-email-review",
    payload={
        "subject": "Q1 Report",
        "body": "Revenue grew 23% YoY...",
        "recipient": "ceo@company.com",
    },
    callback_url="https://example.com/webhook",
    priority="high",
)
```

**MCP (for Claude, Cursor, Windsurf, etc.):**

```json
{
  "mcpServers": {
    "gatewerk": {
      "command": "npx",
      "args": ["@gatewerk/mcp"],
      "env": {
        "GATEWERK_URL": "http://localhost:3100",
        "GATEWERK_API_KEY": "gwk_..."
      }
    }
  }
}
```

### 5. Receive the Decision

When a reviewer acts on a review, Gatewerk POSTs one of three event types to your `callback_url`:

- `review.decided`: reviewer approved or rejected (terminal; may include edits)
- `review.retried`: reviewer requested changes and sent feedback (non-terminal; your agent regenerates and submits a new version)
- `review.expired`: timeout reached with no decision (terminal)

Example `review.decided` payload:

```json
{
  "type": "review.decided",
  "review_id": "gw_rev_abc123",
  "decision": "edited",
  "decided_at": "2026-03-11T10:30:00Z",
  "was_edited": true,
  "suggested_value": { "subject": "Q1 Report", "body": "Revenue grew 23% YoY..." },
  "approved_value": { "subject": "Q1 2026 Report", "body": "Revenue: $4.2M (+23% YoY)..." },
  "reviewer": "alice@company.com",
  "feedback": "Improved title and added specific numbers",
  "action_value": "approve",
  "action_label": "Approve",
  "auto_approved": false
}
```

The `decision` field is one of `approved | rejected | edited | retried | expired`. `action_value` and `action_label` carry the exact button the reviewer clicked (useful for custom action labels). `auto_approved: true` indicates the review was auto-approved by template config rather than a human.

**Action → decision mapping:**

| Reviewer action (template action type) | Resulting `decision` in webhook |
|---|---|
| `approve` (no field edits) | `approved` |
| `approve` (with field edits) | `edited` + `was_edited: true` |
| `reject` | `rejected` |
| `request_changes` | `retried` (via `review.retried` event) |
| timeout reached, no decision | `expired` (via `review.expired` event) |

**Retry round-trip** (for `review.retried`): your agent receives feedback → regenerates output → calls `PUT /api/v1/reviews/:id` with the new payload → review returns to the reviewer's inbox as a new version.

Requests are signed with HMAC-SHA256. Two signature headers are sent on every delivery:

- `X-Webhook-Signature: sha256=<hex>`: v1 legacy envelope, `hex = HMAC(body, secret)`. Simple to verify; does not prevent replay.
- `X-Webhook-Signature-V2: t=<unix-seconds>,v1=<hex>`: v2 replay-safe envelope, `hex = HMAC(\`${t}.${body}\`, secret)`. Verify `t` is within your freshness window (commonly ±300s), then recompute the hex and constant-time compare.

Receivers that care about replay protection should parse v2, enforce a freshness check on `t`, and compare against `v1` within the v2 header. Receivers who only need authenticity may stay on v1 indefinitely: the v1 header is unchanged since v1.0.

Other headers: `X-Webhook-Event` (event type), `X-Webhook-Id` (stable idempotency key across retries; use it for receiver-side dedup), `X-Request-Id` (correlation). Deliveries retry with exponential backoff; after 5 failures the delivery is marked failed.

### 6. Learn from Feedback

Agents query past decisions to improve:

```typescript
const { data } = await gw.feedback.query({
  template: "quickstart-email-review",
  outcome: "edited",
  limit: 10,
});

// data.data contains past reviews with suggested vs approved values
// Use this to improve future outputs
```

## Features

| Feature | Description |
|---------|-------------|
| **Review Templates** | Schema-driven forms with text, markdown, JSON, image, number, boolean, select fields |
| **Rich Actions** | Three action types (`approve`, `reject`, `request_changes`) with custom labels. Inline field editing on `editable: true` fields. |
| **Feedback Memory** | Agents query historical decisions via API |
| **Webhook Notifications** | Event-driven webhooks with HMAC-SHA256 signing |
| **Audit Trail** | HMAC-signed immutable log of every action |
| **Priority Routing** | Low / normal / high / critical with visual indicators |
| **Timeout Policies** | Auto-approve, auto-reject, or expire after deadline |
| **Review Versioning** | Agent submits updated versions after retry feedback |
| **Chains** | Multi-step approvals: each step is its own review, assigned to a user, a role, or an external signer |
| **Decisions by link** | Share one review by expiring link; a client or outside counsel decides with no account and no seat |
| **Team inbox** | Invite teammates with roles; claim, release, and reassign reviews so ownership is always explicit |
| **MCP Server** | Works with Claude, Cursor, Windsurf, and any MCP-compatible agent |
| **TypeScript SDK** | `npm install gatewerk`: resource-based client with `{ data, error }` responses |
| **Python SDK** | `pip install gatewerk`: typed exceptions, Pythonic API |
| **Self-Hosted** | `./scripts/quickstart.sh`: your server, your data |

## Architecture

```
apps/
  api/                  — Express API (REST endpoints, webhook delivery, timeout worker)
  web-next/             — React dashboard (review inbox, forms, settings, metrics)
packages/
  db/                   — Drizzle ORM (PostgreSQL schema)
  sdk-ts/               — TypeScript SDK (npm: gatewerk)
  sdk-py/               — Python SDK (pip: gatewerk)
  mcp/                  — MCP server (npx @gatewerk/mcp)
  n8n-nodes-gatewerk/   — n8n community node (npm: n8n-nodes-gatewerk)
  shared/               — HRP protocol types, ID generator, error classes
docker/                 — Dockerfiles, nginx, compose
```

## API Overview

All resources use prefixed IDs (`gw_rev_`, `gw_tpl_`, `gw_prj_`) and consistent response envelopes.

**Core endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/reviews` | Create a review request |
| `GET` | `/api/v1/reviews` | List reviews (filterable) |
| `GET` | `/api/v1/reviews/:id` | Get review details |
| `POST` | `/api/v1/reviews/:id/decide` | Submit a decision, body: `{ "decision": "approved" }` (`approved \| rejected \| edited \| confirmed \| vetoed`), plus optional `feedback` and `edited_payload` |
| `POST` | `/api/v1/reviews/:id/retry` | Request retry with feedback |
| `PUT` | `/api/v1/reviews/:id` | Update review (new version) |
| `GET` | `/api/v1/feedback` | Query past decisions |
| `GET` | `/api/v1/templates` | List/create/update/delete templates |
| `GET` | `/api/v1/audit` | Query audit log |
| `GET` | `/api/v1/stats` | Review metrics |

**Management endpoints** (dashboard session auth):

| Method | Endpoint | Description |
|--------|----------|-------------|
| `*` | `/api/v1/settings/api-keys` | CRUD + rotate API keys |
| `*` | `/api/v1/settings/webhooks` | CRUD project-level webhook subscriptions |
| `*` | `/api/v1/settings/notifications` | CRUD notification channels |
| `GET`/`POST` | `/api/v1/settings/hmac-secret` | Reveal + rotate HMAC signing secret |
| `*` | `/api/v1/settings/team` | Invite + manage team members |

Full OpenAPI spec at `/api/v1/openapi.json`. Postman collection at `/api/v1/postman.json`.

## Configuration

Key environment variables (see `.env.example` for the full list, including log level, rate limits, media storage paths, and cloud-mode toggles):

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://gatewerk:gatewerk@localhost:5432/gatewerk` | PostgreSQL connection string |
| `HMAC_SECRET` | `dev-secret` | Secret for webhook HMAC signing. Rotate via `POST /api/v1/settings/hmac-secret/rotate`. |
| `JWT_SECRET` | `dev-jwt-secret` | Secret for reviewer session tokens |
| `UI_ORIGIN` | `http://localhost:5173` | CORS origin for the dashboard |
| `PORT` | `3100` | API server port |

**Fixed defaults (not env-configurable today):**

- Review timeout: `86400s` (24h) default, configurable per template (`timeout_seconds`).
- Webhook retries: 5 attempts with exponential backoff; terminal failure marks the delivery failed. (Alert notifications fire only for failed `review.vetoed` and `review.confirmed` deliveries, where a lost decision has agent-side consequences.)
- Payload size limit: 1 MB per webhook delivery; larger bodies are truncated with `review_url` included.

## HRP Protocol

Gatewerk implements the **Human Review Protocol (HRP)**: an open specification for agent-to-human communication. The protocol defines how agents request reviews, how humans respond, and how decisions flow back.

Read the draft spec: [docs/protocol/hrp-v1.md](docs/protocol/hrp-v1.md)

## Philosophy

> Work done for humans is decided by humans.

Agents draft, execute, route, and carry. That is the operational load,
and agents should take as much of it as you trust them with. The
decision, and the ownership that comes with it, stays human. Gatewerk is
the review layer where a human decides before an agent's action reaches
the world.

Three commitments follow:

- **Framework and platform agnostic.** The belief is about humans and
  decisions, not about any AI vendor or stack. Gatewerk works with every
  agent framework and depends on none.
- **Open source.** An audit trail you cannot inspect is marketing. The
  record of your judgment lives on your infrastructure, under a license
  that keeps it open.
- **Decision points designed by a human and decided by a human.** You
  choose where judgment enters the pipeline, and you exercise it. A human
  decides, never a model.

The full doctrine: [docs/philosophy.md](docs/philosophy.md).

## Licensing

The server and dashboard are AGPL-3.0-only; the client SDKs are Apache-2.0; `ee/` is proprietary. Self-hosting for your own use is unrestricted. See [LICENSING.md](LICENSING.md).

## Contributing

We are not yet accepting external contributions to the AGPL-licensed server; issues and discussion are very welcome.

Running from source gives you hot reload on both the API and the dashboard. Postgres still comes from Docker; everything else runs on your machine.

```bash
# Development setup
git clone https://github.com/gatewerk/gatewerk.git
cd gatewerk
cp .env.example .env
pnpm install
docker compose -f docker/docker-compose.dev.yml up -d  # PostgreSQL only
ln -sf ../../.env apps/api/.env                        # Share root .env with the packages that
ln -sf ../../.env packages/db/.env                     # need it: API server and drizzle-kit
pnpm --filter @gatewerk/db run push                    # Apply schema
cd packages/db && bun run src/seed.ts && cd ../..      # Seed demo data and print an API key
pnpm run dev                                           # Start API + dashboard
```

Dashboard: `http://localhost:5174`
API: `http://localhost:3100`

Tests: `pnpm -r test`

### The empty `ee/` directory

`ee/` is a git submodule pointing at a private repository that holds the
commercial hosted-service code. After a normal `git clone` it is an empty
directory, and that is the expected state.

You do not need it. Everything above (install, typecheck, lint, tests, both
Docker images) is built and tested without it, and CI runs that way on every
push so it stays true. Do not run `git clone --recurse-submodules`; the
submodule is private, so that will just fail on authentication.

## License

The server and dashboard are AGPL-3.0-only. Client SDKs (`sdk-ts`, `sdk-py`, `mcp`, `n8n-nodes-gatewerk`) are Apache-2.0. The `ee/` submodule is proprietary and lives in a separate private repository. See [LICENSING.md](LICENSING.md) for details.

---

Leveraged [Claude Code](https://claude.com/claude-code).

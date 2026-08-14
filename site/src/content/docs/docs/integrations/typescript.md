---
title: TypeScript SDK
description: "Create and manage Gatewerk reviews from any TypeScript or JavaScript application: no-throw result pattern, typed errors, webhook verification."
---

The `gatewerk` TypeScript SDK wraps the Gatewerk REST API with a `{ data, error }` result pattern (no exceptions by default), typed error codes, and built-in webhook signature helpers. It targets Node.js, Bun, and edge runtimes with standard `fetch`.

The package publishes to npm at launch. Until then, install from source:

```bash
# From the monorepo (local development)
npm install ./packages/sdk-ts
```

## How do I configure it?

```typescript
import { createClient } from "gatewerk";

const gw = createClient({
  apiKey: process.env.GATEWERK_API_KEY!,
  url: "http://localhost:3100",
});
```

For hosted or remote deployments, replace `http://localhost:3100` with your instance's API URL.

| Option | Description |
|---|---|
| `apiKey` | API key (`gwk_...`). Set via `GATEWERK_API_KEY` env var as fallback. |
| `url` | Base URL of the API (default: `http://localhost:3100`) |

## How do I gate my first action?

```typescript
import { createClient } from "gatewerk";

const gw = createClient({
  apiKey: process.env.GATEWERK_API_KEY!,
  url: "http://localhost:3100",
});

const { data: review, error } = await gw.reviews.create({
  template: "email-review",
  payload: { to: "ceo@acme.com", subject: "Q4 Report", body: draft },
  callback_url: "https://my-agent.example.com/webhook",
  priority: "high",
});

if (error) {
  console.error(error.message, error.code);
} else {
  console.log(review.id);     // gw_rev_...
  console.log(review.status); // pending
}
```

The review appears in the Gatewerk Inbox. Once a human decides it, Gatewerk POSTs the decision to `callback_url`. You can also poll with `gw.reviews.get(id)`.

## How does the decision come back?

`gw.reviews.get(id)` returns `{ data, error }` where `data` is the updated review:

```typescript
const { data: review } = await gw.reviews.get("gw_rev_...");

review.status          // "decided"
review.decision        // values include "approved", "rejected", "edited" and others; see The gate for the full enum
review.approved_value  // the payload the human approved (post-edit if any)
review.payload         // original submitted payload
review.current_version // number
```

For webhook-driven receipt, verify the signature and read the posted body. The snippet lives at [Decisions and webhooks](/docs/concepts/decisions-and-webhooks).

## How do I handle errors?

All methods return `{ data, error }`: no exceptions are thrown. The `error` object carries a stable machine-readable `code`:

```typescript
const { data, error } = await gw.reviews.create({ ... });
if (error) {
  console.error(error.message); // "Missing required fields: template"
  console.error(error.code);    // "missing_required_fields"
  console.error(error.status);  // 400
}
```

Error codes correspond to the HTTP status range:

| Status | When it occurs |
|---|---|
| 400 | Invalid request (bad template slug, missing fields) |
| 401 | API key missing or expired |
| 403 | Key lacks the required scope |
| 404 | Review or template not found |
| 409 | Conflict (e.g. re-deciding an already-decided review) |
| 429 | Rate limit exceeded |

## How do I list reviews?

```typescript
const { data: list } = await gw.reviews.list({ status: "pending" });
// list.items — array of Review
// list.total — total count
// list.has_more — boolean
```

## What else can it do?

**Full resource surface:**

| Resource | Methods |
|---|---|
| `gw.reviews` | `create()`, `get()`, `list()`, `decide()`, `retry()`, `update()`, `cancelRequest()`, `versions()`, `createToken()` |
| `gw.templates` | `list()`, `get()` |
| `gw.feedback` | `query()` |
| `gw.audit` | `query()` |
| `gw.stats` | `summary()` |
| `gw.chains` | `create()`, `get()`, `getForReview()` |
| `gw.notes` | `create()`, `get()`, `list()`, `update()`, `delete()`, `pin()`, `unpin()`, `tags()` |
| `gw.webhooks` | `verify()` |

---

See also: [Quickstart](/docs/quickstart), [The gate](/docs/concepts/the-gate), [Decisions and webhooks](/docs/concepts/decisions-and-webhooks), [Python SDK](/docs/integrations/python)

# gatewerk

TypeScript SDK for [Gatewerk](https://github.com/gatewerk/gatewerk) — the open-source review layer for AI agents. Work done for humans is decided by humans.

## Install

```bash
npm install gatewerk
```

The package ships a single ESM build. `import` is the primary form; `require()`
also resolves it, which needs a Node new enough to require an ES module
(Node 22.12 or later). On an older Node, use `import`.

## Quick Start

```typescript
import { createClient } from "gatewerk";

const gw = createClient({
  apiKey: process.env.GATEWERK_API_KEY!,
  url: "http://localhost:3100",
});

// Submit a review request
const { data: review } = await gw.reviews.create({
  template: "email-review",
  payload: { to: "user@example.com", subject: "Hello", body: "Draft email..." },
  callback_url: "https://your-agent.example.com/callback",
});

// List pending reviews
const { data: list } = await gw.reviews.list({ status: "pending" });

// List available templates
const { data: templates } = await gw.templates.list();

// Get a specific template
const { data: template } = await gw.templates.get("gw_tpl_...");

// Query past decisions (feedback memory)
const { data: feedback } = await gw.feedback.query({ template: "email-review" });

// Verify a webhook signature (v1 — authenticity only, no replay protection).
// For replay-safe verification, parse the X-Webhook-Signature-V2 header
// (`t=<unix-seconds>,v1=<hex>`) and check freshness before comparing hex —
// see "Webhook Verification" below.
const payload = gw.webhooks.verify(rawBody, signatureHeader, hmacSecret);

// Spawn a chain run (sequential approvals; OSS edition)
const { data: chain } = await gw.chains.create({
  definition: {
    version: "1.0",
    mode: "sequential",
    steps: [
      {
        id: "manager-approval",
        template: "deploy",
        assignee: { kind: "role", role: "admin" },
      },
      {
        id: "ops-signoff",
        template: "deploy",
        assignee: { kind: "user", email: "ops@example.com" },
      },
    ],
  },
  initial_payload: { service: "billing-api", version: "v1.42.0" },
});

// Read or list notes pinned to reviews/templates/chain runs
const { data: notes } = await gw.notes.list({ project_id: "gw_proj_..." });
const { data: created } = await gw.notes.create({
  project_id: "gw_proj_...",
  body: "Looks good, but double-check the rate limit settings.",
  is_shared: true,
  attachments: [{ target_kind: "review", target_id: "gw_rev_..." }],
});
```

## Resources

| Resource | Methods |
|----------|---------|
| `gw.reviews` | `create()`, `get()`, `list()`, `decide()`, `retry()`, `update()`, `cancelRequest()`, `versions()`, `createToken()` |
| `gw.templates` | `list()`, `get()` |
| `gw.feedback` | `query()` |
| `gw.audit` | `query()` |
| `gw.stats` | `summary()` |
| `gw.chains` | `create()`, `get()`, `getForReview()` |
| `gw.notes` | `create()`, `get()`, `list()`, `update()`, `delete()`, `pin()`, `unpin()`, `tags()` |
| `gw.webhooks` | `verify()` |

## Webhook Verification

Every Gatewerk delivery carries two signature headers. Verify **either** depending on whether you need replay protection.

### v1 (authenticity only, no replay protection)

`X-Webhook-Signature: sha256=<hex>` where `hex = HMAC(body, secret)`. The SDK's `gw.webhooks.verify()` helper covers this.

```typescript
const payload = gw.webhooks.verify(rawBody, signatureHeader, hmacSecret);
```

### v2 (replay-safe; recommended for new integrations)

`X-Webhook-Signature-V2: t=<unix-seconds>,v1=<hex>` where `hex = HMAC(\`${t}.${body}\`, secret)`. Parse, enforce freshness, then constant-time compare. No SDK helper yet — follow the manual pattern:

```typescript
import { createHmac, timingSafeEqual } from "crypto";

function verifyV2(rawBody: string, header: string, secret: string, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const ts = Number(parts.t);
  const receivedHex = parts.v1;

  if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;

  const expectedHex = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(receivedHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Receivers should also dedup on `X-Webhook-Id` (stable across retries). A v2-verified payload MAY still be a legitimate retry of an earlier event; the header id is the idempotency key.

## Error Handling

All methods return `{ data, error }` — no exceptions thrown.

```typescript
const { data, error } = await gw.reviews.create({ ... });
if (error) {
  console.error(error.message); // "Missing required fields: template"
  console.error(error.code);    // "missing_required_fields"
}
```

## Webhook Verification

Every Gatewerk delivery carries two signature headers. Verify **either** depending on whether you need replay protection.

### v1 (authenticity only, no replay protection)

`X-Webhook-Signature: sha256=<hex>` where `hex = HMAC(body, secret)`. The SDK's `gw.webhooks.verify()` helper covers this.

```typescript
const payload = gw.webhooks.verify(rawBody, signatureHeader, hmacSecret);
```

### v2 (replay-safe; recommended for new integrations)

`X-Webhook-Signature-V2: t=<unix-seconds>,v1=<hex>` where `hex = HMAC(\`${t}.${body}\`, secret)`. Parse, enforce freshness, then constant-time compare. No SDK helper yet — follow the manual pattern:

```typescript
import { createHmac, timingSafeEqual } from "crypto";

function verifyV2(rawBody: string, header: string, secret: string, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const ts = Number(parts.t);
  const receivedHex = parts.v1;

  if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;

  const expectedHex = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(receivedHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Receivers should also dedup on `X-Webhook-Id` (stable across retries). A v2-verified payload MAY still be a legitimate retry of an earlier event; the header id is the idempotency key.

## License

Apache-2.0

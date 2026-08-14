---
title: Decisions and webhooks
description: How your agent learns the outcome via webhook push, polling, and SSE wait, and how to verify a delivery is authentic.
---

When a human decides a review, Gatewerk sends the decision back to your agent. This page covers the three return paths, what a real delivery looks like, and how to verify it.

## How does my agent learn the decision?

Three paths, pick based on your architecture:

| Path | How | When to use |
|---|---|---|
| **Webhook push** | Pass a `callback_url` on `POST /api/v1/reviews`; Gatewerk delivers a `review.decided` POST to that URL when the decision is recorded | Best for production agents running in a server that can receive inbound HTTP |
| **Polling** | `GET /api/v1/reviews/{id}` — check `status` and `decision` | Best for serverless, batch, or short-lived agent processes |
| **SSE wait** | Open a Server-Sent Events stream via `POST /api/v1/events/ticket` then consume the stream; the stream emits `review.decided` when the review settles | Best for interactive agents that need low-latency notification without a public callback endpoint |

## What if the review is part of a chain?

The three paths do not agree for a review that belongs to a chain, and the difference matters.

A chain is a route of approvers: several named humans hold the same request in turn. Each step is its own review, so a step's review reaches `status: "decided"` the moment that one person decides. **The request is not authorized until the whole route finishes.**

| Path | What it does for a chain step |
|---|---|
| **Webhook push** | Neither `review.decided` nor `review.action_taken` is sent for the step. Each step arrives as `chain.step_decided`, and the route authorizes with `chain.completed` |
| **Polling** | `GET /api/v1/reviews/{id}` reports that step's own decision, which is not the authorization. The review carries `chain_run_id`; read `GET /api/v1/reviews/{id}/chain` and wait for the run's `status` to leave `active` |
| **SSE wait** | The stream emits `review.decided` for the step, for the same reason polling does. Apply the same check |

The SDK wait helpers do this for you: they notice `chain_run_id` on the review and keep waiting until the run terminates. If you are polling by hand, check the chain run before you act.

## What does a delivery look like?

The following is an actual `review.decided` delivery captured from a running Gatewerk instance. The review used the `email-review` template; the reviewer approved it with an edit to the `subject` field. Signature values are partially redacted; all header names are exact.

**Headers:**

```
content-type: application/json
user-agent: Gatewerk/0.1.0
x-webhook-event: review.decided
x-webhook-id: gw_del_xUKfzhbskDdzDw803GXT0dea
x-webhook-signature: sha256=8097360d1eef1f10b7e1ead70c8e2360a6c757f07681dace3a0ff8ebf7584f50
x-webhook-signature-v2: t=1783830668,v1=6ed74c6afd72ea04aaae4e332ccf698ee5676d1bdb2a5f73f43d09f9cbeaf61a
webhook-id: gw_del_xUKfzhbskDdzDw803GXT0dea
webhook-timestamp: 1783830668
webhook-signature: v1,RXuAjAUgq+/ZlDL7mouFgc9rwOBr4nMM7y/WqgqWvmg=
```

**Body:**

```json
{
  "type": "review.decided",
  "review_id": "gw_rev_4P5efbb09vp30uZ5EfyLfD1T",
  "decision": "approved",
  "decided_at": "2026-07-12T04:31:08.053Z",
  "was_edited": true,
  "suggested_value": {
    "body": "Hi there, I wanted to reach out about our Q3 promotion...",
    "subject": "Q3 Sales Outreach — Draft",
    "recipient": "prospect@example.com"
  },
  "approved_value": {
    "body": "Hi there, I wanted to reach out about our Q3 promotion...",
    "subject": "Q3 Sales Outreach — Ready to Send"
  },
  "edited_payload": {
    "body": "Hi there, I wanted to reach out about our Q3 promotion...",
    "subject": "Q3 Sales Outreach — Ready to Send"
  },
  "reviewer": "admin@gatewerk.local",
  "action_value": "approve",
  "action_label": "Approve",
  "iteration_count": 0
}
```

## What is the feedback triple?

Three fields in the payload give your agent the precise learning signal:

- **`suggested_value`**: what the agent originally submitted (the untouched payload at review creation). This is what the agent "proposed."
- **`approved_value`**: what the reviewer accepted (original fields merged with any edits). This is what was "approved to proceed."
- **`was_edited`**: `true` if the reviewer changed anything, `false` if approved exactly as submitted.

In the captured example above, `was_edited: true`, and comparing `suggested_value.subject` to `approved_value.subject` shows the reviewer's exact change (the draft subject line was rewritten to a send-ready one). Your agent can store this diff and use it to improve future drafts.

`edited_payload` contains only the fields the reviewer touched, making it easy to extract the delta without comparing the full objects.

## How do I verify a delivery is authentic?

Every Gatewerk delivery carries three overlapping signature schemes so you can adopt whichever your stack supports. All are computed with HMAC-SHA256 using your project's HMAC secret (visible in Settings under the HMAC section).

**`X-Webhook-Signature` (v1: authenticity only):** `sha256=<hex>` where `hex = HMAC(body, secret)`. No replay protection. The TypeScript SDK's `verify()` helper covers this:

```typescript
import { createClient } from "gatewerk";

const gw = createClient({ apiKey: "..." });
const payload = gw.webhooks.verify(rawBody, signatureHeader, hmacSecret);
```

**`X-Webhook-Signature-V2` (v2: replay-safe; recommended for new integrations):** `t=<unix-seconds>,v1=<hex>` where `hex = HMAC(\`${t}.${body}\`, secret)`. Parse, enforce freshness (5-minute window), then constant-time compare:

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

**`webhook-id` / `webhook-timestamp` / `webhook-signature` (Standard Webhooks spec):** `webhook-signature` is `v1,<base64>` where the signed content is `${webhookId}\n${webhookTimestamp}\n${body}`. The `webhook-id` header is stable across retries: use it as your idempotency key to deduplicate retries.

The Python SDK (`gatewerk-python`) has the same `webhooks.verify()` helper for the v1 scheme.

## What if my endpoint is down?

Gatewerk retries failed deliveries automatically. The retry schedule uses exponential backoff with 0 to 30 percent jitter:

| Attempt | Delay before retry |
|---|---|
| 1 (initial) | Immediate |
| 2 | ~1 second |
| 3 | ~5 seconds |
| 4 | ~30 seconds |
| 5 | ~2 minutes |

After 5 attempts the delivery is marked `failed`. The `GET /api/v1/webhooks/deliveries` endpoint lists all delivery attempts with their status, timestamps, and error messages so you can diagnose failures. No automatic recovery runs after the fifth attempt; `GET /api/v1/reviews/{id}` is always the recovery path if your webhook endpoint was unreachable.

A delivery with event `review.veto_delivery_failed` is a first-class alert: it means the agent's callback URL was unreachable for a vetoed monitoring review, and the agent may not know to undo its action. Check your endpoint health when you see this event.

---

See also: [The gate](/docs/concepts/the-gate): review states and idempotency.
[Quickstart](/docs/quickstart): end-to-end example.
[External review](/docs/advanced/external-review): share-link tokens and email-OTP auth for external signers (page lands next).

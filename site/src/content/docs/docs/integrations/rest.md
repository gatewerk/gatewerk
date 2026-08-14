---
title: REST API
description: "Interact with Gatewerk directly over HTTP: create reviews, poll for decisions, and invoke actions using any HTTP client."
---

Gatewerk exposes a versioned REST API under `/api/v1/`. All requests use JSON. No SDK required: a plain `curl` or any HTTP library works.

## How do I authenticate?

Pass an API key in the `Authorization` header:

```
Authorization: Bearer gwk_...
```

There are two credential types:

- **API keys** (`gwk_...`): minted in Settings → API Keys; used by agents and automation.
- **Session JWTs**: issued by `POST /api/v1/auth/login`; used by the dashboard and for reviewer actions (the `/action` endpoint accepts both).

## What does a response look like?

All 4xx/5xx responses share an error envelope with a stable machine-readable `code` field:

```json
{
  "error": {
    "type": "invalid_request",
    "code": "invalid_callback_url",
    "message": "callback_url must be a valid HTTPS URL",
    "doc_url": "https://gatewerk.com/docs/errors/invalid_callback_url"
  }
}
```

Example codes: `invalid_callback_url` (400), `review_not_found` (404).

List endpoints return a consistent envelope:

```json
{
  "object": "list",
  "items": [...],
  "total": 42,
  "has_more": false
}
```

## Core endpoints

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/v1/reviews` | Create a review (pass `idempotency_key` for safe retries: same key returns the same review; terminal conflict → 409 `idempotency_key_terminal_conflict`) |
| `GET` | `/api/v1/reviews/{id}` | Get a review (poll for decision) |
| `POST` | `/api/v1/reviews/{id}/action` | Invoke an action (approve, reject, etc.) |
| `GET` | `/api/v1/reviews` | List reviews (filter by status, priority, template) |
| `GET` | `/api/v1/feedback` | Query decided reviews for learning |

The full reference is at `/api-reference` (interactive Scalar page, lands in a later release). The live OpenAPI spec is always available at `GET /api/v1/openapi.json`.

## How do I create, poll, and decide a review?

Set your API key first (copy it from `docker compose logs gatewerk-seed` or Settings → API Keys):

```bash
export GATEWERK_API_KEY=gwk_...
```

**Step 1: create:**

```bash
curl -X POST http://localhost:3100/api/v1/reviews \
  -H "Authorization: Bearer $GATEWERK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "template": "email-review",
    "payload": {
      "to": "ceo@acme.com",
      "subject": "Q4 Board Update",
      "body": "Dear Board, attached please find the Q4 report.",
      "tone": "formal"
    }
  }'
```

Expected response (HTTP 201):

```json
{
  "object": "review",
  "id": "gw_rev_...",
  "template_slug": "email-review",
  "status": "pending",
  "decision": null,
  "payload": { "to": "ceo@acme.com", "subject": "Q4 Board Update", "body": "...", "tone": "formal" },
  "priority": "normal",
  "created_at": "2026-07-12T04:02:01.676Z",
  "..."
}
```

The response is abridged here; the full body carries every review field.

**Step 2: poll until decided:**

```bash
curl http://localhost:3100/api/v1/reviews/gw_rev_... \
  -H "Authorization: Bearer $GATEWERK_API_KEY"
```

Poll until `"status": "decided"`. The `decision` field values include `approved`, `rejected`, `edited` and others; see [The gate](/docs/concepts/the-gate) for the full enum.

**Step 3: invoke an action (session JWT required for reviewer operations):**

`$SESSION_TOKEN` is the `token` value from a `POST /api/v1/auth/login` response.

```bash
curl -X POST http://localhost:3100/api/v1/reviews/gw_rev_.../action \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action_id": "approve", "feedback": "Looks good"}'
```

Built-in `action_id` values: `approve`, `reject`, `request_changes`, `cancel_iteration`. Custom actions are defined per template.

Expected response (HTTP 200):

```json
{
  "object": "review",
  "id": "gw_rev_...",
  "status": "decided",
  "decision": "approved",
  "decided_by": "admin@gatewerk.local",
  "decided_at": "2026-07-12T04:14:11.291Z",
  "approved_value": { "to": "ceo@acme.com", "subject": "Q4 Board Update", "body": "...", "tone": "formal" },
  "..."
}
```

The response is abridged here; the full body carries every review field.

## How does my agent receive the decision?

**Webhook (push).** Pass `callback_url` in the create request. Gatewerk fires `review.action_taken` when a decision is recorded, except for a review that belongs to a chain: those send `chain.step_decided` per step and authorize with `chain.completed`. For payload shape and signature verification, see [Decisions and webhooks](/docs/concepts/decisions-and-webhooks).

**Polling (pull).** There is no per-review wait endpoint; agents get decisions by polling `GET /reviews/{id}` with their API key until `status` is `decided`, or by configuring webhooks for push delivery.

---

See also: [Quickstart](/docs/quickstart), [The gate](/docs/concepts/the-gate), [Decisions and webhooks](/docs/concepts/decisions-and-webhooks), [Python SDK](/docs/integrations/python)

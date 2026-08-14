---
title: Python SDK
description: "Create and manage Gatewerk reviews from any Python application: sync and async, fully typed, with auto-retry and pagination built in."
---

The `gatewerk` Python SDK wraps the Gatewerk REST API with typed Pydantic models, automatic retry on transient errors, and auto-paginating iterators. It ships sync and async clients so it fits both request-response services and async frameworks like FastAPI or asyncio-based agents.

## How do I install it?

```bash
pip install gatewerk
```

The package is on PyPI at version 0.1.1.

For LangGraph or CrewAI extras, see the respective guides:

```bash
pip install gatewerk[langgraph]
pip install gatewerk[crewai]
```

## How do I configure it?

Pass credentials to the client constructor or set environment variables:

| Variable | Description |
|---|---|
| `GATEWERK_API_KEY` | API key (`gwk_...`). Fallback if not passed to `create_client`. |
| `GATEWERK_URL` | API URL (default: `http://localhost:3100`) |

```python
from gatewerk import create_client

# Explicit
gw = create_client(
    api_key="gwk_...",
    url="http://localhost:3100",
)

# From environment
gw = create_client()  # reads GATEWERK_API_KEY and GATEWERK_URL
```

For hosted or remote deployments, replace `http://localhost:3100` with your instance's API URL.

## How do I gate my first action?

```python
from gatewerk import create_client

gw = create_client(
    api_key="gwk_...",
    url="http://localhost:3100",
)

# Submit a review request
review = gw.reviews.create(
    "email-review",
    payload={"to": "ceo@acme.com", "subject": "Q4 Report", "body": draft},
    callback_url="https://my-agent.com/webhook",
    priority="high",
)
print(review.id)      # gw_rev_...
print(review.status)  # pending
```

The review appears in the Gatewerk Inbox. Once a human decides it, Gatewerk POSTs the decision to `callback_url`. You can also poll with `gw.reviews.get(review.id)` or use auto-pagination to watch for changes.

**Async variant:**

```python
from gatewerk import create_async_client

async with create_async_client(api_key="gwk_...") as gw:
    review = await gw.reviews.create("email-review", payload={...})
    feedback = await gw.feedback.query(template="email-review")
```

## How does the decision come back?

`gw.reviews.get(id)` returns a typed `Review` model after the human acts:

```python
review = gw.reviews.get("gw_rev_...")
review.status          # "decided"
review.decision        # values include "approved", "rejected", "edited", "retried", "expired", and others; see The gate for the full enum
review.approved_value  # dict — the payload the human approved (post-edit if any)
review.payload         # dict — original submitted payload
review.current_version # int
review.auto_approved   # bool | None
```

For webhook-driven receipt, verify the signature first then read the posted body:

```python
from gatewerk import create_client

gw = create_client(api_key="gwk_...")

payload = gw.webhooks.verify(
    raw_body=request.body,
    signature_header=request.headers["X-Webhook-Signature"],
    secret="whsec_...",
)
# payload is a trusted dict: {"event": "review.decided", ...}
```

## What else can it do?

**Error handling**: the SDK raises typed errors so you can handle each case precisely:

```python
from gatewerk import (
    GatewerkError,        # Base — all errors
    InvalidRequestError,  # 400
    AuthenticationError,  # 401
    ForbiddenError,       # 403
    NotFoundError,        # 404
    ConflictError,        # 409
    RateLimitError,       # 429 (includes .retry_after)
)

try:
    review = gw.reviews.get("gw_rev_nonexistent")
except NotFoundError as e:
    print(e.message)      # "Review not found"
    print(e.status_code)  # 404
    print(e.code)         # "review_not_found"
except RateLimitError as e:
    print(e.retry_after)  # seconds until retry
```

The SDK automatically retries on 429, 500, 502, 503, and 504 with exponential backoff. Customize via `max_retries` and `timeout` on `create_client`.

**Auto-pagination:**

```python
for review in gw.reviews.list_auto_paginate(status="pending"):
    print(review.id)
```

**Full resource surface:**

| Resource | Methods |
|---|---|
| `gw.reviews` | `create()` `get()` `list()` `decide()` `retry()` `update()` `cancel_request()` `versions()` `create_token()` `list_auto_paginate()` |
| `gw.templates` | `list()` `get()` `create()` `update()` `delete()` `stats()` |
| `gw.notes` | `create()` `get()` `list()` `list_auto_paginate()` `update()` `delete()` `pin()` `unpin()` `tags()` |
| `gw.feedback` | `query()` |
| `gw.audit` | `query()` |
| `gw.stats` | `get()` |
| `gw.chains` | `create()` `get()` `get_for_review()` |
| `gw.webhooks` | `verify()` `deliveries()` |
| `gw.key_info()` | Introspect API key scopes |

For LangGraph integration, see the [LangGraph guide](/docs/integrations/langgraph).

---

See also: [Quickstart](/docs/quickstart), [The gate](/docs/concepts/the-gate), [Decisions and webhooks](/docs/concepts/decisions-and-webhooks)

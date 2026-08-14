# gatewerk

Python SDK for [Gatewerk](https://github.com/gatewerk/gatewerk) — the open-source review layer for AI agents. Work done for humans is decided by humans.

## Install

```bash
pip install gatewerk
```

## Quick Start

```python
from gatewerk import create_client

gw = create_client(
    api_key="gwk_...",
    url="https://api.gatewerk.com",
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

## Async Support

```python
from gatewerk import create_async_client

async with create_async_client(api_key="gwk_...") as gw:
    review = await gw.reviews.create("email-review", payload={...})
    feedback = await gw.feedback.query(template="email-review")
```

## Framework integrations

| Framework | Install | Status |
|-----------|---------|--------|
| [LangGraph](gatewerk/integrations/langgraph/README.md) | `pip install gatewerk[langgraph]` | available |
| [CrewAI](gatewerk/integrations/crewai/README.md)    | `pip install gatewerk[crewai]` | available |

LangGraph in 30 seconds:

```python
from gatewerk import create_client
from gatewerk.integrations.langgraph import gatewerk_interrupt

gw = create_client(api_key="gwk_...")

def gated_node(state):
    decision = gatewerk_interrupt(gw, template="refund_approval", payload={...})
    return {"approved": decision.approved}
```

See [`gatewerk/integrations/langgraph/README.md`](gatewerk/integrations/langgraph/README.md) for the full guide, including the polling alternative (`await_decision`), async variants, and the LangGraph re-execution caveat.

CrewAI in 30 seconds:

```python
from crewai import Agent, Task, Crew
from gatewerk import create_client
from gatewerk.integrations.crewai import GatewerkApprovalTool

gw = create_client(api_key="gwk_...")
approval_tool = GatewerkApprovalTool(gw, template="refund_approval")

agent = Agent(role="Customer Support", goal="...", tools=[approval_tool])
Crew(agents=[agent], tasks=[Task(description="...", agent=agent, expected_output="...")]).kickoff()
```

The tool pauses the agent, routes the request to the Gatewerk dashboard, and returns `"APPROVED"`, `"REJECTED"`, or `"CHANGES_REQUESTED: ..."` once a human decides. See [`gatewerk/integrations/crewai/README.md`](gatewerk/integrations/crewai/README.md) for the full guide.

## Resources

| Resource | Methods |
|----------|---------|
| `gw.reviews` | `create()` `get()` `list()` `decide()` `retry()` `update()` `cancel_request()` `versions()` `create_token()` `list_auto_paginate()` |
| `gw.chains` | `create()` `get()` `get_for_review()` |
| `gw.notes` | `create()` `get()` `list()` `list_auto_paginate()` `update()` `delete()` `pin()` `unpin()` `tags()` |
| `gw.templates` | `list()` `get()` `create()` `update()` `delete()` `stats()` |
| `gw.feedback` | `query()` |
| `gw.audit` | `query()` |
| `gw.stats` | `get()` |
| `gw.webhooks` | `verify()` `deliveries()` |
| `gw.key_info()` | Introspect API key scopes |

## Typed Responses

All methods return Pydantic models:

```python
from gatewerk import Review, ReviewList, Template, FeedbackList

review = gw.reviews.get("gw_rev_...")
review.id              # str
review.status          # str
review.payload         # dict[str, Any]
review.current_version # int
review.auto_approved   # bool | None
```

## Auto-Pagination

```python
# Iterate all reviews without managing offsets
for review in gw.reviews.list_auto_paginate(status="pending"):
    print(review.id)

# Async
async for review in gw.reviews.list_auto_paginate(status="pending"):
    print(review.id)
```

## Retry & Resilience

The SDK automatically retries on transient errors (429, 500, 502, 503, 504) with exponential backoff and jitter. Rate limit `Retry-After` headers are respected.

```python
# Customize retry behavior
gw = create_client(
    api_key="gwk_...",
    max_retries=5,   # default: 2, set 0 to disable
    timeout=60.0,    # default: 30s
)
```

## Error Handling

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

## Webhook Verification

Every delivery carries two signature headers. Verify **either** depending on whether you need replay protection.

### v1 (authenticity only, no replay protection)

The SDK's `gw.webhooks.verify()` helper accepts the v1 `X-Webhook-Signature` header:

```python
# In your Flask/FastAPI webhook handler
payload = gw.webhooks.verify(
    raw_body=request.body,
    signature_header=request.headers["X-Webhook-Signature"],
    secret="whsec_...",
)
# payload is a trusted dict: {"event": "review.decided", ...}
```

### v2 (replay-safe; recommended for new integrations)

The `X-Webhook-Signature-V2` header carries `t=<unix-seconds>,v1=<hex>` where `hex = HMAC(f"{t}.{body}", secret)`. Parse, enforce freshness, then constant-time compare. No SDK helper yet — follow the manual pattern:

```python
import hmac
import hashlib
import time

def verify_v2(raw_body: bytes, header: str, secret: str, tolerance_seconds: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    ts = int(parts["t"])
    received_hex = parts["v1"]

    # Freshness: reject replays outside the tolerance window.
    if abs(time.time() - ts) > tolerance_seconds:
        return False

    expected_hex = hmac.new(
        secret.encode(),
        f"{ts}.{raw_body.decode()}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected_hex, received_hex)

assert verify_v2(
    request.body,
    request.headers["X-Webhook-Signature-V2"],
    "whsec_...",
)
```

Receivers should also dedup on `X-Webhook-Id` (stable across retries) to survive the legitimate retry flow. A v2-verified payload MAY still be a legitimate retry; the header id is the idempotency key.

## Logging

The SDK logs via Python's standard `logging` module under the `gatewerk` logger:

```python
import logging
logging.getLogger("gatewerk").setLevel(logging.DEBUG)
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GATEWERK_API_KEY` | API key (fallback if not passed to `create_client`) |
| `GATEWERK_URL` | API URL (default: `http://localhost:3100`) |

## License

Apache-2.0

---
title: LangGraph integration
description: Pause a LangGraph graph at a human approval gate, route the review to Gatewerk, and resume the graph with the decision.
---

The `gatewerk[langgraph]` extra adds `gatewerk_interrupt`: a drop-in helper that pauses a LangGraph node, creates a Gatewerk review, waits for a human decision in the dashboard, and resumes the graph with the result. The graph state is preserved across the pause via LangGraph's checkpointer.

## How do I install it?

```bash
pip install gatewerk[langgraph]
```

`gatewerk` itself is on PyPI at 0.1.1. The `[langgraph]` extra pulls in `langgraph` as an additional dependency.

## How do I configure it?

The LangGraph integration uses the same `create_client` constructor as the base SDK:

```python
import os
from gatewerk import create_client

gw = create_client(api_key=os.environ["GATEWERK_API_KEY"])
# GATEWERK_URL defaults to http://localhost:3100
```

For hosted or remote deployments, set `GATEWERK_URL` to your instance's API URL, or pass `url=` to `create_client`.

## How do I gate my first action?

Drop `gatewerk_interrupt` into any LangGraph node:

```python
from gatewerk import create_client
from gatewerk.integrations.langgraph import gatewerk_interrupt
import os

gw = create_client(api_key=os.environ["GATEWERK_API_KEY"])

def gated_node(state):
    decision = gatewerk_interrupt(
        gw,
        template="email-review",
        payload={
            "to": state["to"],
            "subject": state["subject"],
            "body": state["body"],
        },
        priority="high",
    )
    if decision.approved:
        return {"approved_body": (decision.approved_value or {}).get("body", state["body"])}
    return {"approved_body": None, "rejection_reason": decision.feedback}
```

The graph pauses at `gatewerk_interrupt`. A human opens the review in the Gatewerk Inbox and approves, rejects, or edits it. The graph resumes with the decision.

## How does the decision come back?

The `Decision` object returned by `gatewerk_interrupt` (and by polling helpers) carries:

```python
@dataclass(frozen=True)
class Decision:
    review_id: str
    status: str
    decision: str | None          # values include "approved", "rejected", "edited", "retried", "expired", and others; see The gate for the full enum
    approved_value: dict | None   # what the reviewer approved (post-edit if any)
    edited_payload: dict | None   # set when the reviewer edited fields
    feedback: str | None
    reviewer: str | None
    decided_at: str | None

    @property
    def approved(self) -> bool: ...
    @property
    def rejected(self) -> bool: ...
    @property
    def has_changes(self) -> bool: ...  # True when the reviewer edited the payload (edited_payload is set)
```

After a human decides in the Gatewerk dashboard, your webhook handler (or a polling loop) detects `review.decided` and resumes the graph:

```python
from langgraph.types import Command

final = graph.invoke(
    Command(resume={
        "review_id": "gw_rev_...",       # from the webhook payload
        "status": "decided",
        "decision": "approved",
        "approved_value": {"body": "..."},
        "reviewer": "alice@acme.com",
    }),
    config=config,
)
```

## What else can it do?

**Full 3-node example**: the README ships a complete refund approval flow showing conditional routing, auto-approval for small amounts, and human review for large ones. The graph is compiled with a `MemorySaver` checkpointer. Extract it from `packages/sdk-py/gatewerk/integrations/langgraph/README.md`.

**Async graphs:**

```python
from gatewerk import create_async_client
from gatewerk.integrations.langgraph import gatewerk_interrupt_async

async with create_async_client() as gw:
    async def node(state):
        d = await gatewerk_interrupt_async(
            gw, template="email-review", payload={...}
        )
        return {"decision": d.decision}
```

**Polling alternative**: if your runtime has no checkpointer or cannot drive external resumes, use `await_decision` to block the node synchronously:

```python
from gatewerk.integrations.langgraph import await_decision

review = gw.reviews.create("email-review", payload={"to": "...", "subject": "...", "body": "..."})
decision = await_decision(gw, review.id, poll_interval=5.0, timeout=3600)

if decision.approved:
    send_email(decision.approved_value)
```

`await_decision` treats non-terminal statuses as non-terminal and keeps polling until the review reaches a terminal state (decided, rejected, expired, or cancelled). `TimeoutError` is raised if `timeout` elapses.

**Re-execution and duplicate reviews**: LangGraph re-runs the entire node when the graph resumes from `interrupt()`. That means `reviews.create` runs twice: once on the initial pass (creates the real review) and once on the resume pass (creates a stranded duplicate that stays `pending`). The `Decision` returned to your code references the original review id, so business logic is correct, but the duplicate pollutes the queue.

To avoid duplicates entirely, use the split-node pattern: create the review in one node and persist `review.id` into graph state, then call only `interrupt({"review_id": state["review_id"]})` in the next node. The create node runs once; the gate node runs twice but makes no API write.

**Idempotency**: pass `idempotency_key` on `gw.reviews.create(...)` to make retries safe. If a review with that key already exists and is still non-terminal, the API returns the existing row with HTTP 200. If it is already terminal, you get `409 idempotency_key_terminal_conflict`.

---

See also: [Python SDK](/docs/integrations/python), [Quickstart](/docs/quickstart), [The gate](/docs/concepts/the-gate), [Decisions and webhooks](/docs/concepts/decisions-and-webhooks)

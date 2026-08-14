# LangGraph + Gatewerk

**Human approval gates for your agent flows — drop-in for any LangGraph node.**

Pause a LangGraph agent, route the request to a real human via Gatewerk's review dashboard, then resume the graph with the human's decision.

## Install

```bash
pip install gatewerk[langgraph]
```

## 30-second usage

```python
from gatewerk import create_client
from gatewerk.integrations.langgraph import gatewerk_interrupt

gw = create_client(api_key="gwk_...", url="https://api.gatewerk.com")

def gated_node(state):
    decision = gatewerk_interrupt(
        gw,
        template="refund_approval",
        payload={"amount": state["refund_amount"]},
    )
    if decision.approved:
        return {"approved_amount": decision.approved_value["amount"]}
    return {"approved_amount": 0, "reason": decision.feedback}
```

That's it. Drop `gatewerk_interrupt` into any node. The graph pauses, a human makes a call in the Gatewerk dashboard, the graph resumes with the decision.

## Full example: 3-node refund flow

```python
import os
from typing import Optional, TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from gatewerk import create_client
from gatewerk.integrations.langgraph import gatewerk_interrupt


class RefundState(TypedDict):
    customer_id: str
    refund_amount: float
    decision: Optional[str]
    final_amount: Optional[float]
    note: Optional[str]


gw = create_client(api_key=os.environ["GATEWERK_API_KEY"])


def classify(state: RefundState):
    """Auto-approve small refunds; escalate large ones to a human."""
    if state["refund_amount"] < 50:
        return {"decision": "auto_approved", "final_amount": state["refund_amount"]}
    return {}


def human_review(state: RefundState):
    """Pause and route to a human via Gatewerk."""
    d = gatewerk_interrupt(
        gw,
        template="refund_approval",
        payload={
            "customer_id": state["customer_id"],
            "amount": state["refund_amount"],
        },
        priority="high",
    )
    if d.approved:
        amount = (d.approved_value or {}).get("amount", state["refund_amount"])
        return {"decision": "approved", "final_amount": amount, "note": d.feedback}
    return {"decision": "rejected", "final_amount": 0.0, "note": d.feedback}


def issue_refund(state: RefundState):
    """Apply the refund (or skip)."""
    if state["decision"] in ("approved", "auto_approved"):
        # call your payment processor here
        return {}
    return {}


def needs_human(state: RefundState) -> str:
    return END if state.get("decision") == "auto_approved" else "human_review"


builder = StateGraph(RefundState)
builder.add_node("classify", classify)
builder.add_node("human_review", human_review)
builder.add_node("issue_refund", issue_refund)
builder.add_edge(START, "classify")
builder.add_conditional_edges("classify", needs_human, {"human_review": "human_review", END: "issue_refund"})
builder.add_edge("human_review", "issue_refund")
builder.add_edge("issue_refund", END)

graph = builder.compile(checkpointer=MemorySaver())
```

### Driving the graph

```python
config = {"configurable": {"thread_id": "refund-42"}}

# 1. First invoke — hits gatewerk_interrupt(), graph pauses
graph.invoke(
    {"customer_id": "cust_99", "refund_amount": 250.0,
     "decision": None, "final_amount": None, "note": None},
    config=config,
)

# 2. A human approves in the Gatewerk dashboard. Your webhook handler
#    (or a polling loop) detects review.decided and resumes:
final = graph.invoke(
    Command(resume={
        "review_id": "gw_rev_...",          # from the webhook payload
        "status": "decided",
        "decision": "approved",
        "approved_value": {"amount": 250.0},
        "reviewer": "alice@acme.com",
    }),
    config=config,
)

print(final["decision"])      # "approved"
print(final["final_amount"])  # 250.0
```

## Polling pattern (no `interrupt()` needed)

If your runtime can't easily handle LangGraph's interrupt-resume cycle (no checkpointer, no external resume signal), use `await_decision`:

```python
from gatewerk.integrations.langgraph import await_decision

review = gw.reviews.create("refund_approval", payload={"amount": 250.0})
decision = await_decision(gw, review.id, poll_interval=5.0, timeout=3600)

if decision.approved:
    issue_refund(decision.approved_value)
```

Async equivalent: `await await_decision_async(gw, review.id, ...)`.

## Async graphs

```python
from gatewerk import create_async_client
from gatewerk.integrations.langgraph import gatewerk_interrupt_async

async with create_async_client() as gw:
    async def node(state):
        d = await gatewerk_interrupt_async(
            gw, template="refund_approval", payload={...}
        )
        return {"decision": d.decision}
```

## The `Decision` object

```python
@dataclass(frozen=True)
class Decision:
    review_id: str
    status: str
    decision: Optional[str]          # "approved" | "rejected" | "edited" | "retried" | "expired" | "max_iterations_reached"
    approved_value: Optional[dict]   # what the reviewer approved (post-edit if any)
    edited_payload: Optional[dict]   # set when the reviewer edited fields (decision == "edited")
    feedback: Optional[str]
    reviewer: Optional[str]
    decided_at: Optional[str]

    @property
    def approved(self) -> bool: ...
    @property
    def rejected(self) -> bool: ...
    @property
    def has_changes(self) -> bool: ...   # True when the reviewer edited the payload (edited_payload is set)
```

## Error handling

```python
from gatewerk import GatewerkError, RateLimitError

try:
    decision = gatewerk_interrupt(gw, template="x", payload={...})
except RateLimitError as e:
    # The Gatewerk SDK retries 429s automatically; this is the final exhaustion.
    raise
except GatewerkError as e:
    # Network/API problem creating the review. Graph hasn't paused yet.
    log.exception("review create failed")
    raise
```

`TimeoutError` is raised only by `await_decision`/`await_decision_async` when their `timeout` parameter elapses.

## Re-execution caveat

LangGraph re-runs the entire node when the graph resumes from `interrupt()`. That means `client.reviews.create(...)` runs **twice** for one human decision: once on the initial pass (creates the real review), once on the resume pass (creates a duplicate that stays `pending` indefinitely).

The `Decision` returned to your code references the **original** review id (taken from the resume value), not the duplicate, so your business logic is correct. But the duplicate review pollutes your queue.

To avoid duplicates:

- **Use `await_decision`** instead — no re-execution semantics at all.
- **Split the node**: do `client.reviews.create(...)` in one node, persist `review.id` into state, then call only `interrupt(...)` (the LangGraph primitive) in the next node. The SDK doesn't ship a helper for this yet because most teams find a few duplicate `pending` rows acceptable.

## Resume semantics (avoiding ghost reviews)

The 30-second example above calls `gatewerk_interrupt` directly inside the gated node, which is the simplest pattern but trips the re-execution caveat: each resume re-runs the node and re-issues `reviews.create`, leaving a stranded duplicate in the queue. If your project audits `pending` reviews, prefer the **split-node pattern** below — it creates the review exactly once and uses LangGraph's interrupt purely as a pause primitive.

```python
from typing import Optional, TypedDict
from langgraph.graph import END, START, StateGraph
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command, interrupt

from gatewerk import create_client
from gatewerk.integrations.langgraph import await_decision

gw = create_client(api_key=os.environ["GATEWERK_API_KEY"])


class State(TypedDict):
    payload: dict
    review_id: Optional[str]
    decision: Optional[dict]


def create_review_node(state: State):
    """Runs once per chain pass. Persists the review id into graph state
    so the resume pass doesn't re-issue ``reviews.create``."""
    review = gw.reviews.create("refund_approval", state["payload"])
    return {"review_id": review.id}


def gate_node(state: State):
    """Runs twice (initial + resume) but only calls ``interrupt`` —
    no API write here. The resume value carries the decision."""
    resume_value = interrupt({"review_id": state["review_id"]})
    return {"decision": resume_value}


builder = StateGraph(State)
builder.add_node("create_review", create_review_node)
builder.add_node("gate", gate_node)
builder.add_edge(START, "create_review")
builder.add_edge("create_review", "gate")
builder.add_edge("gate", END)
graph = builder.compile(checkpointer=MemorySaver())
```

Resume from your webhook handler with `Command(resume={...})` carrying the `decision` shape (same fields as `Decision`).

If your runtime can't drive resumes at all (no checkpointer, no external resume signal, batch-style execution), drop `interrupt` entirely and use `await_decision` to block the node until a terminal decision lands:

```python
def gate_node(state: State):
    decision = await_decision(gw, state["review_id"], poll_interval=5.0)
    return {"decision": {
        "decision": decision.decision,
        "approved_value": decision.approved_value,
        "feedback": decision.feedback,
    }}
```

`await_decision` treats `pending` as non-terminal, so the loop keeps polling until the review reaches a terminal decision (`approved`, `rejected`, `edited`, `retried`, `expired`, `max_iterations_reached`) or the optional `timeout` elapses.

## Reference

- Gatewerk docs: <https://github.com/gatewerk/gatewerk>
- LangGraph interrupts: <https://docs.langchain.com/oss/python/langgraph/interrupts>

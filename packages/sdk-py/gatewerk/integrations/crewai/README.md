# CrewAI + Gatewerk

**Human approval gates for your CrewAI agents — drop a tool into any agent and pause for a human.**

Give your CrewAI agent a `GatewerkApprovalTool` and the agent decides, in-flow, when an action needs a human's blessing. The tool creates a review in the Gatewerk dashboard, blocks until a human approves or rejects, and returns the decision as a string the LLM can reason about.

## Install

```bash
pip install gatewerk[crewai]
```

## 30-second usage

```python
from crewai import Agent, Task, Crew
from gatewerk import create_client
from gatewerk.integrations.crewai import GatewerkApprovalTool

gw = create_client(api_key="gw_key_...", url="https://api.gatewerk.com")
approval_tool = GatewerkApprovalTool(gw, template="refund_approval")

refund_agent = Agent(
    role="Customer Support",
    goal="Process refund requests fairly",
    tools=[approval_tool],
)

task = Task(
    description="Customer requests a $500 refund. Decide whether to approve.",
    agent=refund_agent,
    expected_output="A clear decision with reasoning",
)

Crew(agents=[refund_agent], tasks=[task]).kickoff()
```

That's it. The agent's LLM reads the tool's description, decides to call it, sees a string back (`"APPROVED"`, `"REJECTED"`, `"CHANGES_REQUESTED: ..."`) and continues the task with that decision baked into its reasoning.

## What the agent sees

When CrewAI registers the tool, the LLM sees:

| Field | Value |
| --- | --- |
| `name` | `gatewerk_approval` (override with `name=...`) |
| `description` | "Submit a decision for human approval before proceeding. Use when an action is irreversible, sensitive, or low-confidence. Returns APPROVED, REJECTED, or CHANGES_REQUESTED." |
| `args_schema` | One field: `payload: dict` (override with `default_payload_key`) |

When the human decides, the tool returns one of:

```
APPROVED                                   # green light
APPROVED: <reviewer feedback>              # green light, with notes
REJECTED                                   # stop
REJECTED: Amount exceeds policy limit      # stop, with reason
CHANGES_REQUESTED: Cap at $100 | edited_payload={'amount': 100}
CLOSED (cancelled)                         # review was cancelled / expired
```

The format is stable — agents can parse the leading verb to branch.

## Configuring the tool

```python
approval_tool = GatewerkApprovalTool(
    gw,
    template="refund_approval",        # required: Gatewerk template slug
    default_payload_key="payload",     # arg key under which the LLM passes review data
    await_timeout=600,                 # max seconds to wait for a decision (None = forever)
    poll_interval=2.0,                 # seconds between status polls
    name="ask_human_about_refund",     # override the LLM-facing tool name
    description="...",                 # override the LLM-facing description
    review_kwargs={                    # forwarded to client.reviews.create()
        "priority": "high",
        "callback_url": "https://my-agent.com/webhook",
    },
)
```

### `default_payload_key`

Controls how the agent's tool args become the review payload:

- **`"payload"` (default).** The LLM passes a dict under `payload` — e.g. the agent calls `gatewerk_approval(payload={"amount": 250, "customer_id": "cust_42"})`. The tool submits that dict as the review payload.
- **`None`.** The args schema accepts arbitrary fields; whatever the LLM passes top-level becomes the payload. Useful when you want the LLM to call `gatewerk_approval(amount=250, customer_id="cust_42")` directly.
- **Any other string.** Pick your own key, e.g. `default_payload_key="action"`.

## Polling pattern (no Tool needed)

If you want to gate something outside the agent's tool-using flow — say, a Crew callback or a custom orchestration step — create the review yourself and use `await_decision`:

```python
from gatewerk.integrations.crewai import await_decision

review = gw.reviews.create("refund_approval", payload={"amount": 250})
decision = await_decision(gw, review.id, poll_interval=5.0, timeout=3600)

if decision.approved:
    issue_refund(decision.approved_value)
```

The async equivalent (`await await_decision_async(gw, review.id, ...)`) is also available.

## The `Decision` object

Same shape as the LangGraph adapter's `Decision`:

```python
@dataclass(frozen=True)
class Decision:
    review_id: str
    status: str
    decision: Optional[str]          # "approved" | "rejected" | "changes_requested"
    approved_value: Optional[dict]   # what the reviewer approved (post-edit if any)
    edited_payload: Optional[dict]   # set when the reviewer edited fields
    feedback: Optional[str]
    reviewer: Optional[str]
    decided_at: Optional[str]

    @property
    def approved(self) -> bool: ...
    @property
    def rejected(self) -> bool: ...
    @property
    def has_changes(self) -> bool: ...
```

Construction goes through `gatewerk.integrations.common`; `gatewerk.integrations.crewai.Decision` and `gatewerk.integrations.langgraph.Decision` are the same class.

## Tool vs callback — which pattern?

CrewAI exposes several human-in-the-loop seams. We default to the tool pattern because it puts the decision in the LLM's hands — the agent reasons about *whether* to ask for approval, not just *when* a fixed callback fires.

| Pattern | When to use |
| --- | --- |
| **`GatewerkApprovalTool` (recommended)** | Agent decides per-step whether to escalate. Most natural for CrewAI's reasoning loop. |
| **`Task(human_input=True)`** | You want every task to end with a human gate, regardless of agent state. CrewAI's built-in stdin-blocking flow — replace with Gatewerk if you want a real review surface. |
| **`Crew(step_callback=...)`** | You want an out-of-band gate after every step. Brittle across CrewAI versions; we ship a `make_step_callback` helper marked **experimental**. |

The `make_step_callback` helper is exported but not part of the stable surface — its signature follows CrewAI's `step_callback` shape, which has churned across minor versions. Prefer the tool pattern unless you have a specific reason.

## Error handling

```python
from gatewerk import GatewerkError, RateLimitError

# The tool's _run lets these propagate. CrewAI catches tool exceptions
# and surfaces them to the agent, but if you want to short-circuit:
try:
    result = approval_tool._run(payload={"amount": 250})
except TimeoutError:
    # await_timeout elapsed before the human decided.
    ...
except RateLimitError:
    # SDK retries 429s automatically; this is the final exhaustion.
    ...
except GatewerkError:
    # Network/API problem creating or polling the review.
    ...
```

## Reference

- Gatewerk docs: <https://github.com/gatewerk/gatewerk>
- CrewAI docs: <https://docs.crewai.com>
- CrewAI BaseTool reference: <https://docs.crewai.com/concepts/tools>

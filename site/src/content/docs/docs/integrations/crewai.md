---
title: CrewAI
description: "Drop a GatewerkApprovalTool into any CrewAI agent to pause for human approval before sensitive actions: the agent's LLM decides when to invoke it."
---

The `gatewerk[crewai]` extra adds a `GatewerkApprovalTool` you can give to any CrewAI agent. The agent's LLM decides when an action needs human approval, invokes the tool, and the crew blocks until a human approves or rejects in the Gatewerk dashboard. The tool returns a string the LLM can reason about and continue from.

## How do I install it?

```bash
pip install gatewerk[crewai]
```

The `gatewerk` base package is on PyPI at version 0.1.1. The `[crewai]` extra bundles the integration adapter.

## How do I configure it?

```python
from gatewerk import create_client
from gatewerk.integrations.crewai import GatewerkApprovalTool

gw = create_client(
    api_key="gwk_...",
    url="http://localhost:3100",
)

approval_tool = GatewerkApprovalTool(gw, template="email-review")
```

For hosted or remote deployments, replace `http://localhost:3100` with your instance's API URL.

## How do I add a human gate to an agent?

```python
from crewai import Agent, Task, Crew
from gatewerk import create_client
from gatewerk.integrations.crewai import GatewerkApprovalTool

gw = create_client(api_key="gwk_...", url="http://localhost:3100")
approval_tool = GatewerkApprovalTool(gw, template="email-review")

email_agent = Agent(
    role="Communications Manager",
    goal="Draft and send external emails with appropriate approvals",
    tools=[approval_tool],
)

task = Task(
    description="Draft a Q4 board update email and get human approval before sending.",
    agent=email_agent,
    expected_output="Confirmation that the email was approved and sent",
)

Crew(agents=[email_agent], tasks=[task]).kickoff()
```

The agent's LLM reads the tool description and decides whether to invoke it. When it does, Gatewerk creates a review in the Inbox and the crew blocks until a human acts.

## How does the decision come back to the agent?

The tool returns a string with a stable leading verb the LLM can parse:

```
APPROVED
APPROVED: <reviewer feedback>
REJECTED
REJECTED: Amount exceeds policy limit
CLOSED (cancelled)
```

These strings flow directly into the agent's reasoning context as the tool result.

## How do I configure the tool?

```python
approval_tool = GatewerkApprovalTool(
    gw,
    template="email-review",           # required: Gatewerk template slug
    default_payload_key="payload",      # arg key the LLM passes review data under
    await_timeout=600,                  # max seconds to wait (None = forever)
    poll_interval=2.0,                  # seconds between status polls
    name="ask_human_before_sending",    # override the LLM-facing tool name
    description="...",                  # override the LLM-facing description
    review_kwargs={                     # forwarded to gw.reviews.create()
        "priority": "high",
        "callback_url": "https://my-agent.example.com/webhook",
    },
)
```

## What does the agent see?

When CrewAI registers the tool, the LLM receives:

| Field | Value |
|---|---|
| `name` | `gatewerk_approval` (override with `name=...`) |
| `description` | "Submit a decision for human approval before proceeding. Use when an action is irreversible, sensitive, or low-confidence. Returns APPROVED, REJECTED, or CLOSED." |
| `args_schema` | One field: `payload: dict` |

## Can I gate something outside the agent's tool loop?

Use `await_decision` directly for crew callbacks or custom orchestration steps:

```python
from gatewerk.integrations.crewai import await_decision

review = gw.reviews.create("email-review", payload={"to": "ceo@acme.com", "subject": "Q4 Report", "body": draft})
decision = await_decision(gw, review.id, poll_interval=5.0, timeout=3600)

if decision.approved:
    send_email(decision.approved_value)
```

The async variant `await_decision_async` is also available.

## What else can it do?

**Error handling**: tool exceptions propagate to CrewAI, which surfaces them to the agent:

```python
from gatewerk import GatewerkError, RateLimitError

try:
    result = approval_tool._run(payload={"to": "ceo@acme.com"})
except TimeoutError:
    # await_timeout elapsed before the human decided
    ...
except RateLimitError:
    # SDK auto-retries 429s; this is final exhaustion
    ...
except GatewerkError:
    # Network or API problem
    ...
```

---

See also: [Quickstart](/docs/quickstart), [The gate](/docs/concepts/the-gate), [Python SDK](/docs/integrations/python), [LangGraph](/docs/integrations/langgraph)

---
title: LangGraph human in the loop
description: How interrupt() works in LangGraph, what it gives you, and what a dedicated review station adds.
---

LangGraph ships a first-class mechanism for pausing a graph and resuming it after a human acts. Understanding what it does, and what it leaves for you to build, is useful whether or not you add external tooling.

## How does LangGraph's native human-in-the-loop work?

LangGraph's answer to human-in-the-loop is `interrupt()`. When your node calls `interrupt(value)`, the graph suspends at that point, checkpoints its entire state (messages, memory, any accumulated values), and raises an `Interrupt` exception that LangGraph catches internally. The graph stays paused in the checkpointer until you call `graph.invoke(Command(resume=<value>), config=config)` with the same thread ID.

This is a solid foundation. The checkpointer (typically a `PostgresSaver` or `MemorySaver`) owns the graph state across the pause, so there is no polling loop, no in-process blocking, and no lost state if the process restarts during the wait. For teams building graph-native workflows where a developer or internal tool provides the resume command, `interrupt()` often covers everything needed.

## What does interrupt() not give you?

`interrupt()` pauses the graph; everything else is yours to build:

- **No reviewer UI.** The review queue exists only in your checkpointer. You need a front end, or a separate Slack/email flow, to show the pending item to the person who needs to decide it.
- **No persistence-independent review queue.** Reviews are not first-class objects; they are suspended graph states inside the checkpointer. Listing "what needs review right now" requires querying the checkpointer for threads in the interrupted state, which is database-specific.
- **No edit-flows-back contract.** If the reviewer wants to correct a field (change an email subject before approving, for instance) you write the convention for how that edit reaches the agent.
- **No audit trail.** There is no record of who decided what, when, and what was changed. Compliance teams asking "show me every human decision on AI-generated content in Q3" have nowhere to query.
- **No path for non-developer reviewers.** `Command(resume=...)` is a programmatic call. A domain expert who does not write code needs a wrapper around it.

None of these are bugs in LangGraph; they reflect scope. `interrupt()` is a graph-execution primitive, not a review system.

## What does a review station add?

A dedicated gate gives the paused graph a place to send the pending review, and gives the reviewer a structured place to decide it. The Gatewerk LangGraph integration (`gatewerk[langgraph]`) replaces the raw `interrupt()` call with `gatewerk_interrupt`, which:

1. Creates a typed review in the Gatewerk Inbox (the reviewer sees it without any extra tooling)
2. Pauses the graph via LangGraph's own `interrupt()` under the hood
3. Delivers the decision back via webhook or polling, then resumes the graph with a `Decision` object

```python
from gatewerk import create_client
from gatewerk.integrations.langgraph import gatewerk_interrupt
import os

gw = create_client(api_key=os.environ["GATEWERK_API_KEY"])

def gated_node(state):
    decision = gatewerk_interrupt(
        gw,
        template="email-review",
        payload={"to": state["to"], "subject": state["subject"], "body": state["body"]},
    )
    if decision.approved:
        return {"body": (decision.approved_value or {}).get("body", state["body"])}
    return {"body": None, "rejection_reason": decision.feedback}
```

The reviewer opens the Inbox, edits or approves the payload, and the graph resumes. The full integration guide is at [LangGraph integration](/docs/integrations/langgraph).

## When do I not need this?

If your reviewer is the developer running the graph, and you are comfortable calling `Command(resume=...)` from the same process, raw `interrupt()` is enough. Similarly, if you already have an internal review UI that writes back to your checkpointer, adding another layer is not justified. The review station pattern earns its place when reviewers are outside your development team, when you need a queryable record of decisions, or when multiple agents share a common review queue.

One practical signal: if you find yourself writing code to enumerate "which threads are currently interrupted and who should look at them," you are building a review queue. That is a reasonable point to consider whether the infrastructure already exists.

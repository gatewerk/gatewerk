# Philosophy

> Work done for humans is decided by humans.

## The Belief

AI agents keep getting more capable, and the work they carry keeps growing.
We believe the main decisions in that work still belong to people. An agent
can draft, execute, route, and carry. That is the operational load, and
agents should take as much of it as you trust them with. The decision, and
the ownership that comes with it, stays human.

Gatewerk exists to make that practical: a review layer where a human decides
before an agent's action reaches the world. Human in the loop is not a
safety feature bolted on. It is the point.

Three commitments follow:

1. **Framework and platform agnostic.** The belief is about humans and
   decisions, not about any AI vendor or stack. Gatewerk works with every
   agent framework and depends on none.
2. **Open source.** An audit trail you cannot inspect is marketing. The
   record of your judgment should live on your infrastructure, under a
   license that keeps it open.
3. **Decision points designed by a human and decided by a human.** You
   choose where judgment enters the pipeline, and you exercise it. A human
   decides, never a model.

## What We Are

An open-source, self-hosted review layer for AI agents. We provide the
infrastructure primitives for the agent-to-human handoff: the moment when an
agent needs a human to review, edit, or decide.

We are to human-in-the-loop what Linux is to operating systems: modular,
composable, extensible, and opinionated about architecture but not about how
you use it.

## What We Are NOT

- Not an agent runtime (use LangGraph, CrewAI, custom scripts, whatever you want)
- Not a monitoring dashboard (watching is a different job; we gate)
- Not a workflow builder (use n8n, Make, Temporal)
- Not a framework (use whatever framework you want)

We sit between your agent and your human. That's it.

## Design Principles

### 1. Do One Thing Well (Unix Philosophy)

The core loop: receive review request → show to human → return decision.
Every feature exists to make this loop better. If a feature doesn't serve
the core loop, it doesn't belong here.

### 2. Modular and Composable

Every piece works independently:

- Core engine works without the UI (headless API)
- UI works with any HRP-compatible engine
- SDKs work with any HRP-compatible station
- Notifications work via webhooks: bring your own bot or service

Users can replace any module. Use our UI or build their own. Use our
notification system or wire their own. Like Linux: the kernel is solid,
everything else is userspace.

### 3. Tools, Not Opinions

We don't ship a Telegram bot; we ship a webhook system. Users connect their
Telegram bot, their Slack workspace, their custom notification service. We
provide the protocol, the routing logic, and the template variables. They
wire it however they want.

Exception: when not providing a built-in option would be an adoption
blocker. If it's trivially expected, we include it. Linux ships with `mail`.

### 4. Don't Reinvent the Wheel

Before building anything, we check whether an open-source library already
does it well, and use it. We build the review primitives and the integration
glue. We don't build form renderers, markdown editors, or notification
systems from scratch when good ones exist.

### 5. Ship What's Needed, Not What's Possible

Features are added when they're needed, not when they're envisioned. Modular
architecture means we CAN add later without rewriting. But we don't build
until the gap is felt.

### 6. Self-Hosted First

The open-source, self-hosted version is the primary product. It must work
perfectly with `docker compose up`. Cloud exists for people who don't want
to self-host, and it is a convenience layer: Cloud never has a capability
the open-source version lacks. The open-source version is never a crippled
version of Cloud.

### 7. Beautiful and Functional UI

Beautiful UI is not optional. The review interface is where non-technical
humans spend their time. If it feels like a developer tool bolted together,
reviewers won't use it. We design with the same care as the architecture.

### 8. Protocol First

We define an open protocol (HRP, the Human Review Protocol) and treat it as
the contract. The product is the reference implementation. If the protocol
is good enough, others will implement it. If they don't, it's still our
clean internal API contract.

### 9. Capture Everything, Show Almost Nothing

The record is maximalist: every action, every distinction, written to the
chained audit log. The surface is minimalist: the inbox shows only what
the decision in front of you needs. The asymmetry is the point. An audit
layer must be simpler than the systems it audits, or it cannot be
trusted, so complexity is spent on the record and saved from the screen.

## The Three Layers

| Layer | What | License |
|-------|------|---------|
| **HRP Protocol** | Open specification document | Apache-2.0 |
| **Gatewerk (self-hosted)** | Server + dashboard (AGPL-3.0-only); client SDKs (Apache-2.0) | AGPL-3.0-only / Apache-2.0 |
| **Cloud** | Managed hosting for the same product | Commercial |

Each layer builds on the previous. Cloud never has features that can't exist
in open source, only convenience.

## The Larger System

Gatewerk is one part of a larger system:
[Millwerk](https://github.com/mrzadexinho/millwerk) senses,
[Warrant](https://github.com/mrzadexinho/warrant) authorizes, Gatewerk
decides. All three are open source; Gatewerk is the furthest along, and
it shipped first because the part where a human decides is the part the
world needed first.

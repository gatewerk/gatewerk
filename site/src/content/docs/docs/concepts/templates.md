---
title: Templates
description: A template is the typed contract that defines what an agent submits and what choices a human gets when deciding.
---

A template is a reusable contract. It tells Gatewerk what fields an agent's payload must contain, which actions are available to the reviewer, and what a decision means for analytics. Every review references exactly one template.

## What is a template?

Two parts:

- **Fields**: the typed schema the agent populates when creating a review. Field names must match `^[a-z0-9_]+$`; types determine how the Inbox renders them and which ones reviewers can edit inline.
- **Actions**: the buttons the reviewer sees. Each action has a kind (`decision`, `iteration`, or `side_effect`) and a label. Built-in decision actions map to the binary `approved`/`rejected` outcomes that power cross-template approval-rate analytics.

## What field types exist?

| Type | Rendered as |
|---|---|
| `text` | Single-line plain text |
| `markdown` | Rendered Markdown (with raw-toggle) |
| `json` | Syntax-highlighted JSON viewer |
| `image` | Inline image (downloaded at intake, served from uploads) |
| `video` | Inline video player |
| `number` | Numeric value |
| `boolean` | True / False chip |
| `select` | Constrained single-choice from a list of options |
| `buttons` | Click-to-select button group |
| `date` | Date display |
| `url` | Clickable hyperlink |

## What is the template lifecycle?

Templates move through three statuses:

| Status | What it allows |
|---|---|
| `draft` | Editable; not published; cannot accept reviews |
| `active` | Published and accepting new reviews; publish is atomic (SELECT-FOR-UPDATE) |
| `inactive` | Paused; existing reviews continue to completion but no new intake is accepted |

**From draft to active.** A template must pass publish validation before it goes active: at least one field, at least one `decision`-kind action, unique action decision values, unique field names, and `select` fields must have at least one option. Failing any check returns a 422 with a specific error.

**Slug immutability.** Once published, a template's slug cannot be renamed. Agents keyed to the old slug get `template_not_found` (404). Retiring a template means creating a new one and coordinating the agent cutover.

**Why active status matters for intake.** A `POST /api/v1/reviews` request that names a `draft` or `inactive` template is refused immediately with `template_draft` or `template_inactive`. The gate never silently opens on a paused template.

## What are actions?

Every template action belongs to one of three kinds:

| Kind | Effect |
|---|---|
| `decision` | Records a terminal decision; maps to `approved` or `rejected` under the hood |
| `iteration` | Requests changes from the agent; moves the review to `awaiting_iteration` |
| `side_effect` | Fires a webhook without recording a decision; leaves the review in its current state |

Built-in presets (`approve`, `reject`, `request_changes`) are always available and map directly to these kinds. Custom action labels ("Clear for Filing," "Ship behind flag," "Hold for legal") are just human-readable aliases on top of the same binary terminal values, keeping cross-template approval-rate analytics answerable without requiring every template to use the same vocabulary.

## What ships out of the box?

`./scripts/quickstart.sh` seeds six templates ready to use immediately:

| Slug | Purpose |
|---|---|
| `proposal-review` | Review AI-generated proposals before sending |
| `email-review` | Review AI-drafted emails before sending |
| `code-deploy` | Approve code deployments to production |
| `content-approval` | Review AI-generated content before publishing |
| `expense-report` | Approve or reject expense claims |
| `customer-reply` | Review AI-drafted customer support replies |

All six are published and active immediately after seeding. The quickstart uses `email-review` as its first example.

## Do pending reviews change when I edit a template?

No. Gatewerk snapshots the template's field schema onto each review at creation time (`template_fields` column, shipped in the v1 hardening cycle). A review always renders with the field labels and types that were active when it was created, regardless of what happens to the template afterward. Re-publishing a template with a changed field order or renamed label does not affect any review that already exists.

This is a deliberate guarantee: the reviewer always sees exactly what the agent submitted in the context the agent intended, not a re-labelled view through a later version of the schema.

---

See also: [The gate](/docs/concepts/the-gate): the review lifecycle and state machine.
[Decisions and webhooks](/docs/concepts/decisions-and-webhooks): how decisions are delivered back to your agent.

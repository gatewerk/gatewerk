---
title: Notes
description: "Sticky context attached to reviews, templates, and chain runs: shared for team collaboration, private for personal use."
---

The core gate carries no freeform context beyond the structured payload. Notes add that layer: persistent text pinned to a review, template, or chain run, visible to the team or kept private to the author.

## What is a note?

A note is a text body (up to 8 KB) with optional tags, attached to a target: a review, a template, or a chain run. Notes are either **shared** (visible to all project members) or **private** (visible only to the author).

Private notes never reach webhooks, audit exports, or any read endpoint accessible to another user. The audit trail records that a private note was created (including metadata such as tag count and the `is_shared: false` flag), but the body is redacted at all read surfaces: including for admins.

## Who can create notes?

Any authenticated caller with `notes:write` scope. The one restriction: API key subjects cannot create private notes. Service identities are not people; a note private to a script would accumulate hidden state invisible to the team.

## What are the per-target caps?

| Cap | Limit |
|---|---|
| Shared notes per target | 50 |
| Private notes per target per author | 50 |
| Body length | 8 KB |
| Tags per note | 10 |

## How do agents use notes?

Agents append shared notes to add context that reviewers should see. Examples:

```bash
# Attach context to a review before it is decided
curl -X POST https://api.gatewerk.com/api/v1/notes \
  -H "Authorization: Bearer $GATEWERK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "body": "Confidence score: 0.71. This draft triggered the low-confidence gate.",
    "tags": ["confidence", "auto-flagged"],
    "is_shared": true,
    "project_id": "gw_proj_...",
    "attachments": [{ "target_kind": "review", "target_id": "gw_rev_..." }]
  }'
```

Notes are append-oriented for agents. The MCP server intentionally omits update and delete tools for notes: agents append context, and humans curate the note shelf.

## What happens to notes when an author is deleted?

When a team member's account is removed, the `author_id` foreign key on their notes is set to `NULL`. Private notes with a null `author_id` become permanently invisible: the visibility predicate requires an author match, and no match is possible for a deleted author. These notes are not garbage-collected; they persist but are unreachable by anyone, including admins. DB intervention is the only path to remove them.

## What are note attachments?

A note is pinned to a target via an attachment record. A single note can be attached to multiple targets. Attachment creation and note insertion are wrapped in a single transaction: if the per-target cap is exceeded by any attachment, the entire operation rolls back and no partial note is created.

Orphaned attachments (where the target review or chain run has been deleted) are garbage-collected within 24 hours.

---

See also: [Feedback memory](/docs/advanced/feedback-memory): the structured query surface for decided reviews (distinct from notes).
[Chains](/docs/advanced/chains): chain runs as a note attachment target.

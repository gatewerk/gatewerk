---
title: External review
description: Share a single review with someone outside your Gatewerk team via a signed URL, with three authentication tiers and a full audit trail.
---

External review is an optional layer: the core loop works without it; adding it lets someone who has no Gatewerk account (a client, legal counsel, or external approver) decide a review on a minimal branded page via a time-limited, revocable share link.

## How does a share token work?

`POST /api/v1/reviews/:id/token` creates a token and returns a `/r/:token` URL. There is at most one active token per review at any time. Creating a second token while one is active returns `409 token_already_active`. The token value is stored hashed; Gatewerk cannot recover the plaintext after delivery.

The external reviewer visits `/r/:token`, authenticates (depending on auth tier), and sees a minimal decision page. They can:

- **Decide**: pick a custom action (terminal; the review reaches `decided`)
- **Decline**: provide a reason; the review reverts to `pending` with a tagged note
- **Raise questions**: submit a question (at least 10 characters); the review reverts to `pending` with the question as a note. There is no automatic follow-up loop; a human must monitor the note.

Revoking a token (`DELETE /api/v1/reviews/:id/token`) atomically reverts the review to `pending` so the internal team can re-assign or re-share.

## What authentication tiers are available?

| Tier | How the external reviewer authenticates |
|---|---|
| `public` | No authentication — anyone with the URL can decide |
| `email_otp` | Reviewer must submit a pinned email address; a 6-digit OTP is sent; code is valid 10 minutes; 60-second resend cooldown; 5 failed attempts trigger a 1-hour DB-persisted lockout |
| `account` | Reviewer must be logged into Gatewerk with a matching account; wrong user gets `account_mismatch` without leaking the bound identity |

### SMTP requirement for email_otp

Choosing `email_otp` requires SMTP to be configured. If SMTP is not configured, the token creation request itself is refused with `409 smtp_not_configured`. Do not assume the OTP can be queued for later delivery.

The recipient-facing OTP send endpoint returns HTTP 200 regardless (anti-enumeration), but if SMTP is absent at send time, the audit trail records `send_status: skipped_no_config` and no code is ever sent. The recipient sees "Code sent" but receives nothing: a dead end only visible in the audit trail.

**Practical rule:** always configure SMTP before using `email_otp` tokens, or use `public` or `account` tiers.

### Account tier grace window

When the `account` tier is used, a 4-hour grace window applies after the reviewer first opens the link. Within this window, the session remains active even if the token's `expiry_hours` would otherwise have elapsed (the grace applies from first open, not from token creation).

## What is the token expiry?

Set `expiry_hours` between 1 and 720 (30 days) when creating the token. After expiry, the link returns "Link Expired" to the recipient. Expired tokens that were never opened are automatically reclaimed by a background sweep, returning the review to `pending` so it does not strand indefinitely.

## What does the audit trail capture?

Every token event is audited: creation, OTP attempts, decisions, declines, questions, and revocations. Forensic fields (`ip_address`, `user_agent`, `decided_by`) are recorded on each event so you can reconstruct the external reviewer's full interaction history.

## How do chain steps use external tokens?

A chain step with an `external_token` assignee kind generates a share token automatically when the step materializes. The URL is included in the `chain.next_step_ready` webhook payload so your agent can forward it to the intended recipient.

---

See also: [Chains](/docs/advanced/chains): external-token assignees in sequential flows.
[The gate](/docs/concepts/the-gate): the `awaiting_external` review status.
[Decisions and webhooks](/docs/concepts/decisions-and-webhooks): the `review.decided` event after an external decision.

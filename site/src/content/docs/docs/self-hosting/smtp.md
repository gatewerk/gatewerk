---
title: SMTP
description: "Configure outbound email for notification delivery and external review links. SMTP is optional: the core review loop works without it."
---

## Do I need SMTP?

No. The core loop (agent submits a review, human decides it via the dashboard, decision returns to the agent) works with no email configuration at all.

What degrades without SMTP:

- **Notification emails**: reviewers do not receive email notifications when new reviews arrive.
- **Email OTP external review links**: share links that require the recipient to verify their email address before viewing a review cannot be created.

Plain external review links (no email verification) and account-tier external review links continue to work regardless of SMTP configuration.

## What happens if I skip it?

The API starts normally and all non-email features work. When SMTP is absent:

- The audit log records `email.send_skipped_no_config` for any notification that would have been sent.
- Attempting to create an `email_otp` share token via `POST /api/v1/reviews/:id/token` is **refused** with HTTP 409 and error code `smtp_not_configured`:

  ```json
  {
    "error": {
      "type": "conflict",
      "code": "smtp_not_configured",
      "message": "Email OTP links require email sending to be configured. Set SMTP_FROM and the SMTP_* variables in your environment and restart the API, or use a public or account link.",
      "doc_url": "https://docs.gatewerk.dev/errors/smtp_not_configured"
    }
  }
  ```

  Plain (`public`) and account-tier (`account`) share tokens are unaffected.

## How do I configure it?

Add the SMTP variables to your `.env` file:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
SMTP_FROM="Your Product <noreply@mail.example.com>"
EMAIL_CONTACT_ADDRESS=support@example.com
```

`SMTP_FROM` accepts a bare address or the `Display Name <address>` form, which is what recipients
see in their inbox list.

`EMAIL_CONTACT_ADDRESS` is optional and is the address a human actually reads. When set, it becomes
the `Reply-To` header and the `List-Unsubscribe` mailto target. Set it whenever your sending address
is a no-reply mailbox, so a recipient who replies reaches someone. Left blank, messages carry no
`Reply-To` and the unsubscribe mailto points at the sending address.

Then restart the API container:

```bash
docker compose up -d gatewerk-api
```

**`SMTP_SECURE`** should be `false` for port 587 (STARTTLS) and `true` for port 465 (implicit TLS).

**Resend alternative.** If you have a [Resend](https://resend.com) API key, set `RESEND_API_KEY` instead of the SMTP host variables. Resend takes priority over SMTP when both are present. `SMTP_FROM` is still required on this path: it supplies the `From` header, and it must be an address on a domain verified in your Resend account, or every send is rejected. Without it the API logs a warning at startup and keeps email disabled rather than failing later in a recipient's face:

```bash
RESEND_API_KEY=re_...
```

The service degrades gracefully if the configured transport fails: it logs the error and records an audit event rather than crashing.

## How do I verify it works?

The dashboard has an email test tool at **Settings** (sidebar) → **Account** → **Send test**. Enter any address and click **Send test**. The panel reports whether the send succeeded, was skipped (no config), or failed with an error message.

The same surface is also available via the API for scripted verification. `$SESSION_TOKEN` is the `token` from a `POST /api/v1/auth/login` response: see [REST API](/docs/integrations/rest) for the login snippet.

```bash
# Check transport status (no email sent)
curl http://localhost:3100/api/v1/settings/email/status \
  -H "Authorization: Bearer $SESSION_TOKEN"

# Send a test email
curl -X POST http://localhost:3100/api/v1/settings/email/test \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to": "you@example.com"}'
```

Both endpoints require an admin session token (not an API key). The status endpoint returns the active transport (`smtp`, `resend`, or `none`) and the test endpoint returns `{"status":"sent","message_id":"...","latency_ms":42}` on success.

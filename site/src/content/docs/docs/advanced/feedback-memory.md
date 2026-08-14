---
title: Feedback memory
description: "Query decided reviews as structured input-output pairs: the human corrections your agent can read before acting."
---

Every decided review is a data point. Feedback memory makes those data points queryable: your agent can read past human decisions before acting, without any additional configuration beyond a standard API call.

## What is the feedback endpoint?

`GET /api/v1/feedback` returns decided reviews in a shape optimized for agent learning loops. Each record carries the original submission, the human's response, and whether the human changed anything.

```bash
curl "https://api.gatewerk.com/api/v1/feedback?template=email-review&outcome=edited&limit=20" \
  -H "Authorization: Bearer $GATEWERK_API_KEY"
```

## What query parameters does the endpoint accept?

| Parameter | Type | Default | Description |
|---|---|---|---|
| `template` | string | (none) | Filter by template slug |
| `outcome` | string | (none) | Filter by decision value (`approved`, `rejected`, `edited`, etc.) |
| `limit` | integer (1–200) | 50 | Number of records to return |
| `offset` | integer | 0 | Pagination offset |

The response uses the standard `{ items, total, has_more }` envelope.

## What does each record contain?

Each feedback record includes the same triple described in [Decisions and webhooks](/docs/concepts/decisions-and-webhooks):

- **`suggested_value`**: the payload as the agent originally submitted it
- **`approved_value`**: the payload the reviewer accepted (original merged with any edits)
- **`was_edited`**: `true` if the reviewer changed any field, `false` if approved exactly as submitted

Comparing `suggested_value` and `approved_value` when `was_edited: true` gives the reviewer's precise correction.

## What is excluded?

**Lapsed monitoring windows are excluded.** A monitoring review that closed because the veto window elapsed without action is attributed to `system:monitoring_window` with `lapsed: true`. These records do not appear in feedback queries. The intent: absence of objection is not a human correction and should not be treated as a training signal.

## How is this different from notes?

Notes are free-text sticky context attached to individual reviews, templates, or chain runs. Feedback memory is the structured query surface for decided reviews. The two are complementary: a reviewer might leave a note explaining their reasoning, and that note appears on the review detail; the feedback endpoint returns the input/output delta across many reviews for pattern analysis.

This endpoint does not perform ranking, similarity matching, or any analysis of content. It returns the records that match the filter parameters.

---

See also: [Decisions and webhooks](/docs/concepts/decisions-and-webhooks): the feedback triple (`suggested_value`, `approved_value`, `was_edited`) in the webhook payload.
[Monitoring](/docs/advanced/monitoring): why lapsed reviews are excluded from feedback.
[Notes](/docs/advanced/notes): per-review context notes.

// Reviews tag — CRUD + decide/retry/cancel-request + archive/unarchive +
// versions + tokens + bulk ops. 12 paths, the largest tag in the spec.
//
// The three review-link token paths live in ./review-tokens and are spread
// back in at their original position, so the generated document keeps the
// same key order it had when they were inline. They moved out when this file
// crossed the 600-line hard cap; splitting on the token boundary follows the
// same seam routes/reviews/tokens.ts already uses.

import { reviewTokenPaths } from "./review-tokens";

export const reviewPaths = {
  "/api/v1/reviews": {
    post: {
      operationId: "createReview",
      tags: ["Reviews"],
      summary: "Create a review",
      description:
        "Agents submit a review request tied to a template. The response is " +
        "returned immediately — the decision (if any) is delivered via " +
        "`callback_url` webhook or retrieved by polling `GET /reviews/:id`.\n\n" +
        "If the template has `auto_approve=true`, the review is created and " +
        "decided in one step; the response includes `decision: \"approved\"` " +
        "and the callback fires immediately.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ReviewCreateBody" },
            examples: {
              minimal: {
                summary: "Minimal",
                value: {
                  template: "content-publish",
                  payload: { title: "Launching v2", body: "We shipped…" },
                },
              },
              full: {
                summary: "All optional fields",
                value: {
                  template: "content-publish",
                  payload: { title: "Launching v2", body: "We shipped…" },
                  callback_url: "https://example.com/gatewerk/callback",
                  priority: "high",
                  confidence: 0.72,
                  irreversibility: "costly_reversible",
                  assignee: "reviewer@example.com",
                  metadata: { thread_id: "t_123" },
                  timeout: { action: "auto_reject", seconds: 3600 },
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Review created (or auto-approved).",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Review" } },
          },
        },
        "400": { $ref: "#/components/responses/InvalidRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "413": { $ref: "#/components/responses/PayloadTooLarge" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
    get: {
      operationId: "listReviews",
      tags: ["Reviews"],
      summary: "List reviews",
      description: "Most recent first. Filter by status / priority / template / assignee.",
      parameters: [
        {
          name: "status",
          in: "query",
          schema: { $ref: "#/components/schemas/ReviewStatus" },
        },
        {
          name: "priority",
          in: "query",
          schema: { $ref: "#/components/schemas/Priority" },
        },
        {
          name: "template",
          in: "query",
          description: "Filter by template slug.",
          schema: { type: "string" },
        },
        { name: "assignee", in: "query", schema: { type: "string" } },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
        {
          name: "offset",
          in: "query",
          schema: { type: "integer", minimum: 0, default: 0 },
        },
      ],
      responses: {
        "200": {
          description: "Paginated list",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ReviewList" } },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },

  "/api/v1/reviews/{id}": {
    parameters: [{ $ref: "#/components/parameters/ReviewId" }],
    get: {
      operationId: "getReview",
      tags: ["Reviews"],
      summary: "Get a review",
      responses: {
        "200": {
          description: "Review (with embedded template for rendering).",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Review" } },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateReview",
      tags: ["Reviews"],
      summary: "Update review payload (new version)",
      description:
        "Used when a reviewer requested changes and the agent resubmits. Pass " +
        "the `version` that's being updated — stale versions are rejected.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["payload", "version"],
              properties: {
                payload: { $ref: "#/components/schemas/JsonObject" },
                version: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated review",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Review" } },
          },
        },
        "400": { $ref: "#/components/responses/InvalidRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { $ref: "#/components/responses/Conflict" },
      },
    },
    delete: {
      operationId: "deleteReview",
      tags: ["Reviews"],
      summary: "Hard-delete a review",
      description: "Cascades to versions, notes, and tokens. Irreversible.",
      responses: {
        "200": { $ref: "#/components/responses/OkFlag" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

  "/api/v1/reviews/{id}/decide": {
    parameters: [{ $ref: "#/components/parameters/ReviewId" }],
    post: {
      operationId: "decideReview",
      tags: ["Reviews"],
      summary: "Submit a decision (deprecated — use /action)",
      deprecated: true,
      description:
        "**DEPRECATED** — alias for `POST /reviews/{id}/action` with " +
        "`action_id=approve|reject` (depending on body.decision). " +
        "Sunset 2026-12-01; v2.0 removes this endpoint per spec §11.3.\n\n" +
        "Approve, reject, or mark edited. If the review has a `callback_url`, " +
        "the new dispatcher dual-fires `review.action_taken` (canonical) and " +
        "`review.decided` (legacy) webhooks per spec §9.2.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ReviewDecideBody" },
          },
        },
      },
      responses: {
        "200": {
          description: "Decision recorded",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Review" } },
          },
        },
        "400": { $ref: "#/components/responses/InvalidRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { $ref: "#/components/responses/Conflict" },
      },
    },
  },

  "/api/v1/reviews/{id}/action": {
    parameters: [{ $ref: "#/components/parameters/ReviewId" }],
    post: {
      operationId: "actionReview",
      tags: ["Reviews"],
      summary: "Invoke a configurable action on a review",
      description:
        "The canonical decide endpoint (spec §3.1). Accepts any action defined " +
        "on the review's template. Built-in `action_id` values: `approve`, " +
        "`reject`, `request_changes`, `cancel_iteration`. Fires a " +
        "`review.action_taken` webhook when a `callback_url` is set. " +
        "Accepts both session (reviewer) and API-key (agent) authentication.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ReviewActionBody" },
            examples: {
              approve: {
                summary: "Approve",
                value: { action_id: "approve" },
              },
              reject: {
                summary: "Reject with feedback",
                value: { action_id: "reject", feedback: "Not ready." },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Action recorded. Review returned with updated status.",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Review" } },
          },
        },
        "400": { $ref: "#/components/responses/InvalidRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { $ref: "#/components/responses/Conflict" },
      },
    },
  },

  "/api/v1/reviews/{id}/retry": {
    parameters: [{ $ref: "#/components/parameters/ReviewId" }],
    post: {
      operationId: "retryReview",
      tags: ["Reviews"],
      summary: "Request changes from the agent (deprecated — use /action)",
      deprecated: true,
      description:
        "**DEPRECATED** — alias for `POST /reviews/{id}/action` with " +
        "`action_id=request_changes`. Sunset 2026-12-01; v2.0 removes this " +
        "endpoint per spec §11.3.\n\n" +
        "Transitions a `pending` review to `awaiting_iteration` (canonical; " +
        "legacy `changes_requested` storage is auto-tolerated) and dual-fires " +
        "`review.action_taken` + `review.retried` webhooks. The agent is " +
        "expected to resubmit via `PUT /reviews/:id`.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["feedback"],
              properties: {
                feedback: { type: "string", minLength: 1 },
                prompt_edit: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Retry requested",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Review" } },
          },
        },
        "400": { $ref: "#/components/responses/InvalidRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

  "/api/v1/reviews/{id}/cancel-request": {
    parameters: [{ $ref: "#/components/parameters/ReviewId" }],
    post: {
      operationId: "cancelReviewRequest",
      tags: ["Reviews"],
      summary: "Cancel a pending change request (deprecated — use /action)",
      deprecated: true,
      description:
        "**DEPRECATED** — alias for `POST /reviews/{id}/action` with " +
        "`action_id=cancel_iteration`. Sunset 2026-12-01; v2.0 removes this " +
        "endpoint per spec §11.3.\n\n" +
        "Reverts `awaiting_iteration` (or legacy `changes_requested`) → " +
        "`pending`. Useful if the reviewer retracts a request.",
      responses: {
        "200": {
          description: "Reverted",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Review" } },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

  "/api/v1/reviews/{id}/archive": {
    parameters: [{ $ref: "#/components/parameters/ReviewId" }],
    post: {
      operationId: "archiveReview",
      tags: ["Reviews"],
      summary: "Archive (soft-delete) a review",
      responses: {
        "200": {
          description: "Archived",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Review" } },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

  "/api/v1/reviews/{id}/unarchive": {
    parameters: [{ $ref: "#/components/parameters/ReviewId" }],
    post: {
      operationId: "unarchiveReview",
      tags: ["Reviews"],
      summary: "Restore an archived review",
      responses: {
        "200": {
          description: "Unarchived",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Review" } },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

  "/api/v1/reviews/{id}/versions": {
    parameters: [{ $ref: "#/components/parameters/ReviewId" }],
    get: {
      operationId: "listReviewVersions",
      tags: ["Reviews"],
      summary: "List payload versions",
      description: "History of payloads for a review, ordered newest first.",
      responses: {
        "200": {
          description: "Versions",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["items"],
                properties: {
                  items: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ReviewVersion" },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

  ...reviewTokenPaths,

  "/api/v1/reviews/bulk/archive": {
    post: {
      operationId: "bulkArchiveReviews",
      tags: ["Reviews"],
      summary: "Bulk archive",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/BulkIdsBody" },
          },
        },
      },
      responses: {
        "200": { $ref: "#/components/responses/BulkCount" },
        "400": { $ref: "#/components/responses/InvalidRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

  "/api/v1/reviews/bulk/delete": {
    post: {
      operationId: "bulkDeleteReviews",
      tags: ["Reviews"],
      summary: "Bulk hard-delete",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/BulkIdsBody" },
          },
        },
      },
      responses: {
        "200": { $ref: "#/components/responses/BulkCount" },
        "400": { $ref: "#/components/responses/InvalidRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;

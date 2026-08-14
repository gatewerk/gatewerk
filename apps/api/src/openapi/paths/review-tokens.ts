// Review-link token paths, split out of paths/reviews.ts
// when that file crossed the 600-line hard cap. Same "Reviews" tag and the
// same operationIds; only the file boundary moved, so the generated document
// is byte-identical to before the split.
//
// Covers the three token operations the Inbox share dialog drives: list
// history, mint, revoke.

export const reviewTokenPaths = {
  "/api/v1/reviews/{id}/tokens": {
    parameters: [{ $ref: "#/components/parameters/ReviewId" }],
    get: {
      operationId: "listReviewTokens",
      tags: ["Reviews"],
      summary: "List review-link token history",
      description:
        "Returns every token ever minted for this review (active, used, " +
        "revoked, expired) newest-first. Read-only projection backing the " +
        "v1.4 token-history panel.",
      parameters: [
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        {
          name: "offset",
          in: "query",
          schema: { type: "integer", minimum: 0, default: 0 },
        },
      ],
      responses: {
        "200": {
          description: "Token history page",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ListReviewTokensResponse" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

  "/api/v1/reviews/{id}/token": {
    parameters: [{ $ref: "#/components/parameters/ReviewId" }],
    post: {
      operationId: "createReviewToken",
      tags: ["Reviews"],
      summary: "Generate a review-link token",
      description:
        "Mints a single-use token and URL path (`/r/{token}`) that lets an " +
        "unauthenticated reviewer decide this review. Requires the template " +
        "to have `enable_review_links: true` and the review to be `pending`.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["purpose", "recipient_label"],
              properties: {
                purpose: {
                  type: "string",
                  minLength: 1,
                  maxLength: 80,
                  description: "Short, operator-supplied reason this token is being minted. Surfaced in the audit trail.",
                },
                recipient_label: {
                  type: "string",
                  minLength: 1,
                  maxLength: 200,
                  description: "Human-readable label for the recipient (e.g., name or email). Surfaced in the audit trail and inbox.",
                },
                note: {
                  type: "string",
                  maxLength: 1000,
                  nullable: true,
                  description: "Optional free-form note attached to the token.",
                },
                auth_level: {
                  type: "string",
                  enum: ["public", "email_otp", "account"],
                  default: "public",
                  description:
                    "Auth tier required to consume the token. All three tiers are fully supported. 'public' asks nothing of the recipient and leaves the decision unattributed beyond recipient_label. 'email_otp' requires auth_email and makes the recipient prove control of that address with a 6 digit code before deciding. 'account' requires auth_user_id and makes the recipient sign in. The wire default stays 'public' for back-compat; the Inbox share dialog defaults to 'email_otp'.",
                },
                auth_email: {
                  type: "string",
                  format: "email",
                  maxLength: 254,
                  nullable: true,
                  description: "Email pinned to the token when auth_level is email_otp.",
                },
                auth_user_id: {
                  type: "string",
                  maxLength: 64,
                  nullable: true,
                  description: "Reviewer id pinned to the token when auth_level is account.",
                },
                expiryHours: {
                  type: "integer",
                  minimum: 1,
                  maximum: 720,
                  description: "Hours until the token expires. Defaults to 48.",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Token created",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ReviewToken" },
            },
          },
        },
        "400": { $ref: "#/components/responses/InvalidRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "409. The review, its template, or the deployment cannot support the requested link. Codes: 'monitoring_not_shareable' (a monitoring review is never shareable), 'no_recipient_action' (the template exposes no decision action to a link recipient), 'smtp_not_configured' (auth_level 'email_otp' needs outbound email configured, since a code that can never be sent strands the recipient).",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        "422": {
          description:
            "422. Cross-field validation failed. Returned when the contextual field required by the chosen auth_level is absent, or when a field belonging to another tier is present. Codes: 'auth_level.email_required', 'auth_level.user_id_required', 'auth_level.contextual_fields_not_allowed_for_public', 'auth_level.user_id_not_allowed_for_email_otp', 'auth_level.email_not_allowed_for_account'.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
  },

  "/api/v1/reviews/{id}/token/revoke": {
    parameters: [{ $ref: "#/components/parameters/ReviewId" }],
    post: {
      operationId: "revokeReviewToken",
      tags: ["Reviews"],
      summary: "Revoke the active review-link token",
      description:
        "Marks the active review-link token revoked and reverts the review " +
        "to pending. Token-redesign Phase 1 (§4.4). Optional reason is captured " +
        "in the token.revoked audit event but not stored on the token row.",
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                reason: {
                  type: "string",
                  maxLength: 500,
                  description: "Optional reason captured in the audit event.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Token revoked",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["success"],
                properties: {
                  success: { type: "boolean", enum: [true] },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

} as const;

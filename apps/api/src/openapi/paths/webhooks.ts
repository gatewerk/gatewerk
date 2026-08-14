// Webhooks tag — inspect outbound delivery attempts (read-only).
// The management surface (webhook CRUD, HMAC secret) lives in /settings/*
// and is deliberately excluded from the agent-facing spec.

export const webhookPaths = {
  "/api/v1/webhooks/deliveries": {
    get: {
      operationId: "listWebhookDeliveries",
      tags: ["Webhooks"],
      summary: "List webhook delivery attempts",
      description:
        "Returns the delivery log for outbound webhooks from this project. " +
        "Useful for debugging failing callbacks. Scoped to this project's reviews.",
      parameters: [
        {
          name: "review_id",
          in: "query",
          description: "Filter to one review's deliveries.",
          schema: { type: "string" },
        },
        {
          name: "status",
          in: "query",
          schema: {
            type: "string",
            enum: ["pending", "delivered", "failed"],
          },
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
        { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
      ],
      responses: {
        "200": {
          description: "Delivery attempts",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WebhookDeliveryList" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
} as const;

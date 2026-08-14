// Feedback tag — query decided reviews for learning loops.

export const feedbackPaths = {
  "/api/v1/feedback": {
    get: {
      operationId: "listFeedback",
      tags: ["Feedback"],
      summary: "Query decided reviews",
      description:
        "Returns decided reviews in a shape optimized for training/eval loops. " +
        "Includes original vs edited payloads and reviewer feedback strings.",
      parameters: [
        {
          name: "template",
          in: "query",
          description: "Filter by template slug.",
          schema: { type: "string" },
        },
        {
          name: "outcome",
          in: "query",
          description: "Filter by decision.",
          schema: { $ref: "#/components/schemas/Decision" },
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
          description: "Feedback items",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/FeedbackList" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
} as const;

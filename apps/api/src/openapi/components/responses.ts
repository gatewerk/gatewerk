// OpenAPI reusable responses. All 4xx/5xx reference the shared `Error` schema.

export const responses = {
  InvalidRequest: {
    description: "400 Bad Request. Validation failed.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  Unauthorized: {
    description: "401. Missing or invalid API key.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  Forbidden: {
    description: "403. Key lacks the required scope or template access.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  NotFound: {
    description: "404. Resource not found.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  Conflict: {
    description: "409. State conflict (e.g. stale version, non-pending review).",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  PayloadTooLarge: {
    description: "413. Total payload exceeds 5 MB or a field exceeds 1 MB.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  RateLimited: {
    description: "429. Per-key rate limit exceeded.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  OkFlag: {
    description: "Success flag envelope.",
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean", const: true } },
        },
      },
    },
  },
  BulkCount: {
    description: "Success with affected count.",
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["ok", "count"],
          properties: {
            ok: { type: "boolean", const: true },
            count: { type: "integer", minimum: 0 },
          },
        },
      },
    },
  },
} as const;

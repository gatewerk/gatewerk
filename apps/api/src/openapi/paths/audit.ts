// Audit tag — immutable log of actions on this project.

export const auditPaths = {
  "/api/v1/audit": {
    get: {
      operationId: "listAuditEvents",
      tags: ["Audit"],
      summary: "Query the audit log",
      parameters: [
        { name: "action", in: "query", schema: { type: "string" } },
        { name: "resource_type", in: "query", schema: { type: "string" } },
        { name: "resource_id", in: "query", schema: { type: "string" } },
        { name: "actor", in: "query", schema: { type: "string" } },
        {
          name: "from",
          in: "query",
          description: "ISO-8601 lower bound (inclusive).",
          schema: { type: "string", format: "date-time" },
        },
        {
          name: "to",
          in: "query",
          description: "ISO-8601 upper bound (inclusive).",
          schema: { type: "string", format: "date-time" },
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
          description: "Audit events",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AuditList" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
} as const;

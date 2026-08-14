// Stats tag — aggregate counts and throughput metrics.

export const statsPaths = {
  "/api/v1/stats": {
    get: {
      operationId: "getStats",
      tags: ["Stats"],
      summary: "Aggregate metrics for the project",
      responses: {
        "200": {
          description: "Counts and averages",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Stats" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
} as const;

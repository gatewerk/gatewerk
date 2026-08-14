// Meta tag — version info and key introspection.

export const metaPaths = {
  "/api/v1": {
    get: {
      operationId: "getVersion",
      tags: ["Meta"],
      summary: "Version info",
      description: "Returns the API version and HRP protocol version. Public, no auth.",
      security: [],
      responses: {
        "200": {
          description: "Version info",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["version", "protocol", "name"],
                properties: {
                  version: { type: "string", example: "1" },
                  protocol: { type: "string", example: "HRP/1.0" },
                  name: { type: "string", example: "Gatewerk" },
                },
              },
            },
          },
        },
        default: {
          description: "Unexpected error.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
  },

  "/api/v1/auth/key-info": {
    get: {
      operationId: "getKeyInfo",
      tags: ["Meta"],
      summary: "Introspect the current API key",
      description:
        "Returns the prefix and scope list of the API key used to make the " +
        "request. Useful for clients that want to surface permissions to users.",
      responses: {
        "200": {
          description: "Key info",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "prefix"],
                properties: {
                  object: { type: "string", const: "key_info" },
                  prefix: { type: "string", example: "gwk_abf42c19" },
                  scopes: {
                    type: ["array", "null"],
                    items: { $ref: "#/components/schemas/Scope" },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
} as const;

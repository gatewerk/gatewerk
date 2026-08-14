// OpenAPI securitySchemes — Gatewerk uses bearer API keys only.

export const securitySchemes = {
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "gwk_*",
    description:
      "Pass an API key as `Authorization: Bearer gwk_…`. Mint keys in " +
      "Settings → API Keys. Scope required per endpoint — see the `Scope` enum.",
  },
} as const;

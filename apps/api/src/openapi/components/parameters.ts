// OpenAPI reusable path parameters.

export const parameters = {
  ReviewId: {
    name: "id",
    in: "path",
    required: true,
    description: "Review ID (prefix `gw_rev_`).",
    schema: { type: "string" },
  },
  TemplateId: {
    name: "id",
    in: "path",
    required: true,
    description: "Template ID (prefix `gw_tpl_`).",
    schema: { type: "string" },
  },
} as const;

// Templates tag — CRUD + publish/pause/resume lifecycle.

export const templatePaths = {
  "/api/v1/templates": {
    get: {
      operationId: "listTemplates",
      tags: ["Templates"],
      summary: "List templates",
      responses: {
        "200": {
          description: "Templates in this project.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TemplateList" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    post: {
      operationId: "createTemplate",
      tags: ["Templates"],
      summary: "Create a template",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/TemplateCreateBody" },
          },
        },
      },
      responses: {
        "201": {
          description: "Created",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Template" } },
          },
        },
        "400": { $ref: "#/components/responses/InvalidRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },

  "/api/v1/templates/{id}": {
    parameters: [{ $ref: "#/components/parameters/TemplateId" }],
    get: {
      operationId: "getTemplate",
      tags: ["Templates"],
      summary: "Get a template",
      responses: {
        "200": {
          description: "Template",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Template" } },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateTemplate",
      tags: ["Templates"],
      summary: "Update a template",
      description:
        "All fields are optional — pass only the ones you want to change. " +
        "Updates take effect on the next review created from this template.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/TemplateUpdateBody" },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Template" } },
          },
        },
        "400": { $ref: "#/components/responses/InvalidRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteTemplate",
      tags: ["Templates"],
      summary: "Delete a template",
      description: "Existing reviews are kept; new reviews using the slug will be rejected.",
      responses: {
        "200": {
          description: "Deleted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  object: { type: "string", const: "template" },
                  id: { type: "string" },
                  deleted: { type: "boolean", const: true },
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

  "/api/v1/templates/{id}/publish": {
    parameters: [{ $ref: "#/components/parameters/TemplateId" }],
    post: {
      operationId: "publishTemplate",
      tags: ["Templates"],
      summary: "Publish a draft",
      description: "Promotes `draft_config` to the live columns atomically.",
      responses: {
        "200": {
          description: "Published",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Template" } },
          },
        },
        "400": { $ref: "#/components/responses/InvalidRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

  "/api/v1/templates/{id}/pause": {
    parameters: [{ $ref: "#/components/parameters/TemplateId" }],
    post: {
      operationId: "pauseTemplate",
      tags: ["Templates"],
      summary: "Pause a template",
      description: "Sets `status=inactive`. New review requests for this slug return 400.",
      responses: {
        "200": {
          description: "Paused",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Template" } },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

  "/api/v1/templates/{id}/resume": {
    parameters: [{ $ref: "#/components/parameters/TemplateId" }],
    post: {
      operationId: "resumeTemplate",
      tags: ["Templates"],
      summary: "Resume a paused template",
      responses: {
        "200": {
          description: "Resumed",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Template" } },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;

import { z } from "zod";
import {
  TemplateObjectSchema,
  TemplateListResponseSchema,
  TemplateCreateBodySchema,
  TemplateUpdateBodySchema,
  TemplateDraftCreateBodySchema,
  TemplateDraftUpdateBodySchema,
  type TemplateCreateBody,
  type TemplateUpdateBody,
  type TemplateDraftCreateBody,
  type TemplateDraftUpdateBody,
} from "@gatewerk/shared";
import { defineQuery, defineMutation } from "./client/define";
import { request } from "./client/http";

export type Template = z.infer<typeof TemplateObjectSchema>;
export type TemplateListPage = z.infer<typeof TemplateListResponseSchema>;

const DeletedResponseSchema = z.object({
  object: z.literal("template").optional(),
  id: z.string(),
  deleted: z.boolean(),
});

type DeletedResponse = z.infer<typeof DeletedResponseSchema>;

type TemplateListInput = Record<string, never>;

export const listTemplates = defineQuery<TemplateListInput, TemplateListPage>({
  path: "/api/v1/templates",
  queryKey: () => ["templates", "list"] as const,
  responseSchema: TemplateListResponseSchema,
});

export const getTemplate = defineQuery<{ id: string }, Template>({
  path: ({ id }: { id: string }) => `/api/v1/templates/${encodeURIComponent(id)}`,
  queryKey: ({ id }: { id: string }) => ["templates", "detail", id] as const,
  responseSchema: TemplateObjectSchema,
});

export const createTemplateMutation = defineMutation<TemplateCreateBody, Template>({
  path: "/api/v1/templates",
  method: "POST",
  bodySchema: TemplateCreateBodySchema,
  responseSchema: TemplateObjectSchema,
});

export const updateTemplateMutation = defineMutation<
  { id: string } & TemplateUpdateBody,
  Template
>({
  path: ({ id }: { id: string }) => `/api/v1/templates/${encodeURIComponent(id)}`,
  method: "PUT",
  responseSchema: TemplateObjectSchema,
});

export const deleteTemplateMutation = defineMutation<{ id: string }, DeletedResponse>({
  path: ({ id }: { id: string }) => `/api/v1/templates/${encodeURIComponent(id)}`,
  method: "DELETE",
  bodyless: true,
  responseSchema: DeletedResponseSchema,
});

export const createDraftTemplateMutation = defineMutation<TemplateDraftCreateBody, Template>({
  path: "/api/v1/templates/draft",
  method: "POST",
  bodySchema: TemplateDraftCreateBodySchema,
  responseSchema: TemplateObjectSchema,
});

// Draft update has a `{id, draft}` input shape but only `draft` belongs in the body
// (id is in the path). defineMutation's default serializer would wrap both, so use
// request directly and parse the response through the shared schema.
async function sendDraftUpdate(id: string, draft: TemplateDraftUpdateBody): Promise<Template> {
  const raw = await request<unknown>(`/api/v1/templates/${encodeURIComponent(id)}/draft`, {
    method: "PATCH",
    body: JSON.stringify(draft),
  });
  const parsed = TemplateObjectSchema.safeParse(raw);
  if (!parsed.success) {
    if (import.meta.env?.DEV) console.warn("[api] template draft update schema mismatch", parsed.error.issues);
    return raw as Template;
  }
  return parsed.data;
}

export const publishTemplateMutation = defineMutation<{ id: string }, Template>({
  path: ({ id }) => `/api/v1/templates/${encodeURIComponent(id)}/publish`,
  method: "POST",
  bodyless: true,
  responseSchema: TemplateObjectSchema,
});

export const discardDraftTemplateMutation = defineMutation<{ id: string }, Template>({
  path: ({ id }) => `/api/v1/templates/${encodeURIComponent(id)}/draft`,
  method: "DELETE",
  bodyless: true,
  responseSchema: TemplateObjectSchema,
});

export const pauseTemplateMutation = defineMutation<{ id: string }, Template>({
  path: ({ id }) => `/api/v1/templates/${encodeURIComponent(id)}/pause`,
  method: "POST",
  bodyless: true,
  responseSchema: TemplateObjectSchema,
});

export const resumeTemplateMutation = defineMutation<{ id: string }, Template>({
  path: ({ id }) => `/api/v1/templates/${encodeURIComponent(id)}/resume`,
  method: "POST",
  bodyless: true,
  responseSchema: TemplateObjectSchema,
});

export const templates = {
  list: () => listTemplates.run({}),
  get: (id: string) => getTemplate.run({ id }),
  create: (data: TemplateCreateBody) => createTemplateMutation(data),
  update: (id: string, data: TemplateUpdateBody) =>
    updateTemplateMutation({ id, ...data }),
  delete: (id: string) => deleteTemplateMutation({ id }),
  createDraft: (initial: TemplateDraftCreateBody = {}) =>
    createDraftTemplateMutation(initial),
  updateDraft: (id: string, draft: TemplateDraftUpdateBody) =>
    sendDraftUpdate(id, draft),
  publish: (id: string) => publishTemplateMutation({ id }),
  discardDraft: (id: string) => discardDraftTemplateMutation({ id }),
  pause: (id: string) => pauseTemplateMutation({ id }),
  resume: (id: string) => resumeTemplateMutation({ id }),
};

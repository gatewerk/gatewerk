import { z } from "zod";
import {
  WebhookObjectSchema,
  WebhookListResponseSchema,
  WebhookCreateBodySchema,
  WebhookTestBodySchema,
  WebhookTestResponseSchema,
  type WebhookCreateBodyInput,
  type WebhookUpdateBody,
  type WebhookTestBodyInput,
  type WebhookTestResponse,
} from "@gatewerk/shared";
import { defineQuery, defineMutation } from "./client/define";

export type Webhook = z.infer<typeof WebhookObjectSchema>;
export type WebhookListPage = z.infer<typeof WebhookListResponseSchema>;

type Empty = Record<string, never>;

export const listWebhooks = defineQuery<Empty, WebhookListPage>({
  path: "/api/v1/settings/webhooks",
  queryKey: () => ["settings", "webhooks"] as const,
  responseSchema: WebhookListResponseSchema,
});

export const createWebhookMutation = defineMutation<WebhookCreateBodyInput, Webhook>({
  path: "/api/v1/settings/webhooks",
  method: "POST",
  bodySchema: WebhookCreateBodySchema,
  responseSchema: WebhookObjectSchema,
});

export const updateWebhookMutation = defineMutation<
  { id: string } & WebhookUpdateBody,
  Webhook
>({
  path: ({ id }: { id: string }) => `/api/v1/settings/webhooks/${encodeURIComponent(id)}`,
  method: "PUT",
  responseSchema: WebhookObjectSchema,
});

export const deleteWebhookMutation = defineMutation<{ id: string }, void>({
  path: ({ id }: { id: string }) => `/api/v1/settings/webhooks/${encodeURIComponent(id)}`,
  method: "DELETE",
  bodyless: true,
});

export const testWebhookMutation = defineMutation<WebhookTestBodyInput, WebhookTestResponse>({
  path: "/api/v1/settings/webhooks/test",
  method: "POST",
  bodySchema: WebhookTestBodySchema,
  responseSchema: WebhookTestResponseSchema,
});

export const webhooks = {
  list: () => listWebhooks.run({}),
  create: (data: WebhookCreateBodyInput) => createWebhookMutation(data),
  update: (id: string, data: WebhookUpdateBody) => updateWebhookMutation({ id, ...data }),
  delete: (id: string) => deleteWebhookMutation({ id }),
  test: (data: WebhookTestBodyInput) => testWebhookMutation(data),
};

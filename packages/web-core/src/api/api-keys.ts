import { z } from "zod";
import {
  ApiKeyObjectSchema,
  ApiKeyListResponseSchema,
  ApiKeyWithSecretSchema,
  ApiKeyCreateBodySchema,
  ApiKeyUsageResponseSchema,
  type ApiKeyCreateBody,
  type ApiKeyUpdateBody,
  type ApiKeyUsageResponse,
} from "@gatewerk/shared";
import { defineQuery, defineMutation } from "./client/define";

// Namespace-facing input shapes: widen `scopes` from the strict `Scope[]` enum
// to `string[]` so call sites typing scopes as `string[]` (legacy form state)
// compile cleanly. The Zod bodySchema on the mutation still validates at
// runtime, so invalid scopes throw before the request fires.
type ApiKeyCreateInput = Omit<ApiKeyCreateBody, "scopes"> & { scopes: string[] };
type ApiKeyUpdateInput = Omit<ApiKeyUpdateBody, "scopes"> & { scopes?: string[] };

export type ApiKey = z.infer<typeof ApiKeyObjectSchema>;
export type ApiKeyListPage = z.infer<typeof ApiKeyListResponseSchema>;
export type ApiKeyWithSecret = z.infer<typeof ApiKeyWithSecretSchema>;

// The test endpoint spreads the envelope'd review plus `test: true`. Callers
// don't introspect beyond `test`, so keep the schema permissive via passthrough.
const TestRequestResponseSchema = z
  .object({
    test: z.literal(true),
    id: z.string().optional(),
    template_slug: z.string().optional(),
  })
  .passthrough();

export type TestRequestResponse = z.infer<typeof TestRequestResponseSchema>;

type Empty = Record<string, never>;

export const listApiKeys = defineQuery<Empty, ApiKeyListPage>({
  path: "/api/v1/settings/api-keys",
  queryKey: () => ["settings", "api-keys"] as const,
  responseSchema: ApiKeyListResponseSchema,
});

export const createApiKeyMutation = defineMutation<ApiKeyCreateBody, ApiKeyWithSecret>({
  path: "/api/v1/settings/api-keys",
  method: "POST",
  bodySchema: ApiKeyCreateBodySchema,
  responseSchema: ApiKeyWithSecretSchema,
});

export const updateApiKeyMutation = defineMutation<
  { id: string } & ApiKeyUpdateBody,
  ApiKey
>({
  path: ({ id }: { id: string }) => `/api/v1/settings/api-keys/${encodeURIComponent(id)}`,
  method: "PUT",
  responseSchema: ApiKeyObjectSchema,
});

export const deleteApiKeyMutation = defineMutation<{ id: string }, void>({
  path: ({ id }: { id: string }) => `/api/v1/settings/api-keys/${encodeURIComponent(id)}`,
  method: "DELETE",
  bodyless: true,
});

export const rotateApiKeyMutation = defineMutation<{ id: string }, ApiKeyWithSecret>({
  path: ({ id }: { id: string }) => `/api/v1/settings/api-keys/${encodeURIComponent(id)}/rotate`,
  method: "POST",
  bodyless: true,
  responseSchema: ApiKeyWithSecretSchema,
});

export const sendTestRequestMutation = defineMutation<{ id: string }, TestRequestResponse>({
  path: ({ id }: { id: string }) => `/api/v1/settings/api-keys/${encodeURIComponent(id)}/test`,
  method: "POST",
  bodyless: true,
  responseSchema: TestRequestResponseSchema,
});

type UsageInput = { id: string; recent_limit?: number };

export const getApiKeyUsage = defineQuery<UsageInput, ApiKeyUsageResponse>({
  path: ({ id }: UsageInput) => `/api/v1/settings/api-keys/${encodeURIComponent(id)}/usage`,
  search: ({ recent_limit }: UsageInput) => ({ recent_limit }),
  queryKey: ({ id, recent_limit }: UsageInput) =>
    ["settings", "api-keys", id, "usage", recent_limit ?? 10] as const,
  responseSchema: ApiKeyUsageResponseSchema,
});

export const apiKeys = {
  list: () => listApiKeys.run({}),
  create: (data: ApiKeyCreateInput) => createApiKeyMutation(data as ApiKeyCreateBody),
  update: (id: string, data: ApiKeyUpdateInput) =>
    updateApiKeyMutation({ id, ...data } as { id: string } & ApiKeyUpdateBody),
  delete: (id: string) => deleteApiKeyMutation({ id }),
  rotate: (id: string) => rotateApiKeyMutation({ id }),
  sendTestRequest: (id: string) => sendTestRequestMutation({ id }),
  getUsage: (id: string, recent_limit?: number) => getApiKeyUsage.run({ id, recent_limit }),
  usageQuery: (id: string, recent_limit?: number) => getApiKeyUsage({ id, recent_limit }),
};

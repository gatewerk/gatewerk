import { z } from "zod";
import {
  ProjectSettingsObjectSchema,
  ProjectUpdateBodySchema,
  HmacSecretPreviewResponseSchema,
  HmacSecretResponseSchema,
  HmacSecretRotateResponseSchema,
  type ProjectUpdateBody,
} from "@gatewerk/shared";
import { defineQuery, defineMutation } from "./client/define";

export type ProjectSettings = z.infer<typeof ProjectSettingsObjectSchema>;
export type HmacSecretPreviewResponse = z.infer<typeof HmacSecretPreviewResponseSchema>;
export type HmacSecretResponse = z.infer<typeof HmacSecretResponseSchema>;
export type HmacSecretRotateResponse = z.infer<typeof HmacSecretRotateResponseSchema>;

type Empty = Record<string, never>;

export const getProjectSettings = defineQuery<Empty, ProjectSettings>({
  path: "/api/v1/settings/project",
  queryKey: () => ["settings", "project"] as const,
  responseSchema: ProjectSettingsObjectSchema,
});

export const updateProjectSettingsMutation = defineMutation<ProjectUpdateBody, ProjectSettings>({
  path: "/api/v1/settings/project",
  method: "PUT",
  bodySchema: ProjectUpdateBodySchema,
  responseSchema: ProjectSettingsObjectSchema,
});

// GET returns preview-only (prefix + has_secret). The full secret is available
// exclusively via revealHmacSecretMutation or rotateHmacSecretMutation — both
// emit audit log entries on every call.
export const getHmacSecretPreview = defineQuery<Empty, HmacSecretPreviewResponse>({
  path: "/api/v1/settings/hmac-secret",
  queryKey: () => ["settings", "hmac-secret"] as const,
  responseSchema: HmacSecretPreviewResponseSchema,
});

export const revealHmacSecretMutation = defineMutation<Empty, HmacSecretResponse>({
  path: "/api/v1/settings/hmac-secret/reveal",
  method: "POST",
  bodyless: true,
  responseSchema: HmacSecretResponseSchema,
});

export const rotateHmacSecretMutation = defineMutation<Empty, HmacSecretRotateResponse>({
  path: "/api/v1/settings/hmac-secret/rotate",
  method: "POST",
  bodyless: true,
  responseSchema: HmacSecretRotateResponseSchema,
});

export const projects = {
  get: () => getProjectSettings.run({}),
  update: (data: ProjectUpdateBody) => updateProjectSettingsMutation(data),
  getHmacSecretPreview: () => getHmacSecretPreview.run({}),
  revealHmacSecret: () => revealHmacSecretMutation({}),
  rotateHmacSecret: () => rotateHmacSecretMutation({}),
};

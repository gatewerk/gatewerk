import {
  EmailStatusResponseSchema,
  EmailTestBodySchema,
  EmailTestResponseSchema,
  type EmailStatusResponse,
  type EmailTestBody,
  type EmailTestResponse,
} from "@gatewerk/shared";
import { defineQuery, defineMutation } from "./client/define";

type Empty = Record<string, never>;

export const getEmailStatus = defineQuery<Empty, EmailStatusResponse>({
  path: "/api/v1/settings/email/status",
  queryKey: () => ["settings", "email", "status"] as const,
  responseSchema: EmailStatusResponseSchema,
});

export const testEmailMutation = defineMutation<EmailTestBody, EmailTestResponse>({
  path: "/api/v1/settings/email/test",
  method: "POST",
  bodySchema: EmailTestBodySchema,
  responseSchema: EmailTestResponseSchema,
});

export const email = {
  status: () => getEmailStatus.run({}),
  test: (data: EmailTestBody) => testEmailMutation(data),
};

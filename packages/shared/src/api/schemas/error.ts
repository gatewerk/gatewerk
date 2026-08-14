import { z } from "zod";

export const ApiErrorBodySchema = z.object({
  error: z.object({
    type: z.string(),
    code: z.string(),
    message: z.string(),
    param: z.string().optional(),
    doc_url: z.string().optional(),
    details: z.unknown().optional(),
  }),
});

export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

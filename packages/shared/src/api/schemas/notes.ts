import { z } from "zod";

export const NOTE_BODY_MAX_BYTES = 8 * 1024;
export const NOTE_TAG_REGEX = /^[a-z0-9][a-z0-9_\-]{0,31}$/;
export const NOTE_TAGS_MAX = 10;
export const NOTE_ATTACHMENTS_MAX = 10;
export const NOTE_TARGET_SHARED_MAX = 50;
export const NOTE_TARGET_PRIVATE_PER_AUTHOR_MAX = 50;

export const NoteTargetKindSchema = z.enum(["review", "template", "chain_run"]);
export type NoteTargetKind = z.infer<typeof NoteTargetKindSchema>;

const TagSchema = z.string().regex(NOTE_TAG_REGEX, "tag must match [a-z0-9][a-z0-9_-]{0,31}");
const TagsSchema = z.array(TagSchema).max(NOTE_TAGS_MAX, `at most ${NOTE_TAGS_MAX} tags`);

// TextEncoder is universal (browser-native + Node 11+). Buffer is Node-only,
// and @gatewerk/shared is consumed client-side by apps/web.
function bodyByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export const NoteAttachmentSchema = z.object({
  id: z.string(),
  target_kind: NoteTargetKindSchema,
  target_id: z.string(),
  attached_by: z.string().nullable(),
  attached_at: z.string(),
});
export type NoteAttachment = z.infer<typeof NoteAttachmentSchema>;

export const NoteSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  author_id: z.string().nullable(),
  author_display_fallback: z.string().nullable(),
  body: z.string(),
  tags: z.array(z.string()),
  is_shared: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  attachments: z.array(NoteAttachmentSchema),
});
export type Note = z.infer<typeof NoteSchema>;

export const NoteListResponseSchema = z.object({
  items: z.array(NoteSchema),
  total: z.number(),
  has_more: z.boolean(),
});
export type NoteListResponse = z.infer<typeof NoteListResponseSchema>;

export const CreateNoteAttachmentInput = z.object({
  target_kind: NoteTargetKindSchema,
  target_id: z.string().min(1),
});

export const CreateNoteBodySchema = z.object({
  body: z.string()
    .min(1, "body required")
    .refine((s) => bodyByteLength(s) <= NOTE_BODY_MAX_BYTES, {
      message: `body exceeds ${NOTE_BODY_MAX_BYTES} bytes`,
    }),
  tags: TagsSchema.default([]),
  is_shared: z.boolean().default(false),
  attachments: z.array(CreateNoteAttachmentInput).max(NOTE_ATTACHMENTS_MAX).default([]),
  // project_id is required for session subjects (no req.projectId from
  // dual-auth middleware) and ignored for api_key subjects (handler reads
  // req.projectId first). Optional here so the same schema validates both
  // paths without forcing api_key clients to echo their own project id.
  project_id: z.string().optional(),
});
export type CreateNoteBody = z.infer<typeof CreateNoteBodySchema>;

export const PatchNoteBodySchema = z.object({
  body: z.string()
    .min(1)
    .refine((s) => bodyByteLength(s) <= NOTE_BODY_MAX_BYTES, {
      message: `body exceeds ${NOTE_BODY_MAX_BYTES} bytes`,
    })
    .optional(),
  tags: TagsSchema.optional(),
  is_shared: z.boolean().optional(),
  updated_at: z.string(),
});
export type PatchNoteBody = z.infer<typeof PatchNoteBodySchema>;

export const PinNoteBodySchema = CreateNoteAttachmentInput;
export type PinNoteBody = z.infer<typeof PinNoteBodySchema>;

// Express parses query strings as strings, never as
// booleans. `z.coerce.boolean()` calls `Boolean(v)` which returns true for
// every non-empty string — including "false". So `?is_shared=false` was
// silently coerced to `is_shared=true` and the Private filter on the shelf
// returned the same list as the Shared filter. Map the two literal strings
// explicitly so unknown values fall through to "undefined" (no filter)
// rather than the historical-buggy `true`.
const QueryBoolean = z
  .union([z.boolean(), z.literal("true"), z.literal("false")])
  .transform((v) => (typeof v === "boolean" ? v : v === "true"));

export const ListNotesQuerySchema = z.object({
  project_id: z.string(),
  author_id: z.string().optional(),
  is_shared: QueryBoolean.optional(),
  // Express parses ?tags=a&tags=b as an array, but ?tags=a as a string.
  // Accept both shapes so callers don't have to repeat the param to satisfy
  // Zod's array constraint when filtering on a single tag.
  tags: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  attached_to_kind: NoteTargetKindSchema.optional(),
  attached_to_id: z.string().optional(),
  has_attachments: QueryBoolean.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListNotesQuery = z.infer<typeof ListNotesQuerySchema>;

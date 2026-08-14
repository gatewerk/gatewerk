import { z } from "zod";
import {
  NoteSchema,
  NoteListResponseSchema,
  CreateNoteBodySchema,
  type Note,
  type NoteListResponse,
  type CreateNoteBody,
  type PatchNoteBody,
  type PinNoteBody,
  type ListNotesQuery,
} from "@gatewerk/shared";
import { defineQuery, defineMutation } from "./client/define";

// Input type for createNote callers — accepts the minimal {body, project_id}
// shape. CreateNoteBody (re-exported below for downstream consumers) is the
// post-defaults output type; the schema's defaults (tags=[], is_shared=false,
// attachments=[]) fill the missing fields server-side.
type CreateNoteInput = z.input<typeof CreateNoteBodySchema>;

export type { Note, NoteListResponse, CreateNoteBody, PatchNoteBody, PinNoteBody, ListNotesQuery };
export type { CreateNoteInput };

const TagListSchema = z.object({ items: z.array(z.string()) });
type TagList = z.infer<typeof TagListSchema>;

// Build the list URL by hand because URLSearchParams.set drops the multi-value
// shape needed for `?tags=a&tags=b`. The server accepts repeated `tags` params
// and Zod's z.union<string|string[]> resolves both cases to the array branch.
function buildListPath(input: ListNotesQuery): string {
  const params = new URLSearchParams();
  params.set("project_id", input.project_id);
  if (input.author_id) params.set("author_id", input.author_id);
  if (input.is_shared !== undefined) params.set("is_shared", String(input.is_shared));
  if (input.tags) for (const t of input.tags) params.append("tags", t);
  if (input.attached_to_kind) params.set("attached_to_kind", input.attached_to_kind);
  if (input.attached_to_id) params.set("attached_to_id", input.attached_to_id);
  if (input.has_attachments !== undefined) {
    params.set("has_attachments", String(input.has_attachments));
  }
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  return `/api/v1/notes?${params.toString()}`;
}

export const listNotes = defineQuery<ListNotesQuery, NoteListResponse>({
  path: (input) => buildListPath(input),
  queryKey: (input) => ["notes", "list", input] as const,
  responseSchema: NoteListResponseSchema,
});

export const getNote = defineQuery<{ id: string }, Note>({
  path: ({ id }) => `/api/v1/notes/${encodeURIComponent(id)}`,
  queryKey: ({ id }) => ["notes", "detail", id] as const,
  responseSchema: NoteSchema,
});

export const listNoteTags = defineQuery<{ project_id: string }, TagList>({
  path: ({ project_id }) =>
    `/api/v1/notes/tags?project_id=${encodeURIComponent(project_id)}`,
  queryKey: ({ project_id }) => ["notes", "tags", { project_id }] as const,
  responseSchema: TagListSchema,
});

// Server validates via CreateNoteBodySchema (with defaults filled). The
// schema's input type allows {body, project_id} only; fields with .default()
// (tags, is_shared, attachments) are optional on input but present on output,
// so we can't pass the schema as bodySchema without a structural mismatch.
// Skipping client-side validation matches patchNote and pinNote.
export const createNote = defineMutation<CreateNoteInput, Note>({
  path: "/api/v1/notes",
  method: "POST",
  responseSchema: NoteSchema,
});

export const patchNote = defineMutation<{ id: string } & PatchNoteBody, Note>({
  path: ({ id }) => `/api/v1/notes/${encodeURIComponent(id)}`,
  method: "PATCH",
  responseSchema: NoteSchema,
});

export const deleteNote = defineMutation<{ id: string }, void>({
  path: ({ id }) => `/api/v1/notes/${encodeURIComponent(id)}`,
  method: "DELETE",
  bodyless: true,
  responseSchema: z.void(),
});

// Server-side PinNoteBodySchema strips the path id from the body, so client
// validation is skipped here — same pattern as patchNote where the input
// type is wider than the body schema.
export const pinNote = defineMutation<{ id: string } & PinNoteBody, { id: string }>({
  path: ({ id }) => `/api/v1/notes/${encodeURIComponent(id)}/attachments`,
  method: "POST",
  responseSchema: z.object({ id: z.string() }).passthrough(),
});

export const unpinNote = defineMutation<{ id: string; attId: string }, void>({
  path: ({ id, attId }) =>
    `/api/v1/notes/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attId)}`,
  method: "DELETE",
  bodyless: true,
  responseSchema: z.void(),
});

export const notes = {
  list: (input: ListNotesQuery) => listNotes.run(input),
  get: (id: string) => getNote.run({ id }),
  tags: (project_id: string) => listNoteTags.run({ project_id }),
  create: (input: CreateNoteInput) => createNote(input),
  patch: (id: string, input: PatchNoteBody) => patchNote({ id, ...input }),
  delete: (id: string) => deleteNote({ id }),
  pin: (id: string, target: PinNoteBody) => pinNote({ id, ...target }),
  unpin: (id: string, attId: string) => unpinNote({ id, attId }),
};

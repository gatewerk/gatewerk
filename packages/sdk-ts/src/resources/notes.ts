import type { Result } from "../errors.js";
import { retryingRequest } from "../http.js";

// Wave 2 (Phase A coverage). Mirrors the notes layer mounted by
// apps/api/src/routes/notes/{read,write,attachments,tags}.ts:
//   POST   /api/v1/notes
//   GET    /api/v1/notes
//   GET    /api/v1/notes/:id
//   PATCH  /api/v1/notes/:id
//   DELETE /api/v1/notes/:id
//   POST   /api/v1/notes/:id/attachments
//   DELETE /api/v1/notes/:id/attachments/:attId
//   GET    /api/v1/notes/tags
//
// Type shapes mirror packages/shared/src/api/schemas/notes.ts (Note,
// NoteAttachment, CreateNoteBody, PatchNoteBody, ListNotesQuery,
// PinNoteBody). The SDK can't depend on @gatewerk/shared at runtime — see
// the same rationale in chains.ts — so we restate the shapes here. Keep them
// structurally compatible with the Zod schemas; backend is the source of
// truth.
//
// Error codes the backend emits:
//   - note_not_found, target_not_found, attachment_not_found
//   - cross_project_forbidden, not_author, not_authorized
//   - api_key_cannot_create_private
//   - stale_updated_at (PATCH conflict — refetch + retry)
//   - attachment_cap, target_attachment_cap
//   - missing_project_id

export type NoteTargetKind = "review" | "template" | "chain_run";

export interface NoteAttachment {
  id: string;
  target_kind: NoteTargetKind;
  target_id: string;
  attached_by: string | null;
  attached_at: string;
}

export interface Note {
  id: string;
  project_id: string;
  author_id: string | null;
  author_display_fallback: string | null;
  body: string;
  tags: string[];
  is_shared: boolean;
  created_at: string;
  updated_at: string;
  attachments: NoteAttachment[];
}

export interface NoteListResult {
  items: Note[];
  total: number;
  has_more: boolean;
}

export interface NoteTagsResult {
  items: string[];
}

export interface CreateNoteAttachmentInput {
  target_kind: NoteTargetKind;
  target_id: string;
}

export interface CreateNoteInput {
  body: string;
  tags?: string[];
  is_shared?: boolean;
  attachments?: CreateNoteAttachmentInput[];
  // session callers must echo project_id; api_key callers may omit (server
  // resolves from the key). See packages/shared/src/api/schemas/notes.ts.
  project_id?: string;
}

export interface PatchNoteInput {
  body?: string;
  tags?: string[];
  is_shared?: boolean;
  // updated_at is the optimistic concurrency guard — must match the row's
  // current updated_at exactly. Mismatch yields 409 stale_updated_at.
  updated_at: string;
}

export interface ListNotesFilters {
  project_id: string;
  author_id?: string;
  is_shared?: boolean;
  tags?: string[];
  attached_to_kind?: NoteTargetKind;
  attached_to_id?: string;
  has_attachments?: boolean;
  cursor?: string;
  limit?: number;
}

export class NotesResource {
  constructor(
    private baseUrl: string,
    private headers: () => Record<string, string>,
  ) {}

  // Retry helper centralised in ../http.ts. Also
  // handles the 204 No Content branch (DELETE handlers) used by unpin().
  private async request<T>(url: string, init?: RequestInit): Promise<Result<T>> {
    return retryingRequest<T>(url, init, this.headers);
  }

  async create(input: CreateNoteInput): Promise<Result<Note>> {
    return this.request(`${this.baseUrl}/api/v1/notes`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async get(id: string): Promise<Result<Note>> {
    return this.request(`${this.baseUrl}/api/v1/notes/${id}`, { method: "GET" });
  }

  async list(filters: ListNotesFilters): Promise<Result<NoteListResult>> {
    const params = new URLSearchParams();
    params.set("project_id", filters.project_id);
    if (filters.author_id) params.set("author_id", filters.author_id);
    if (filters.is_shared !== undefined) params.set("is_shared", String(filters.is_shared));
    if (filters.tags?.length) {
      // Express parses repeated `?tags=a&tags=b` as an array — backend Zod
      // schema also accepts a single string and wraps to array (see
      // ListNotesQuerySchema in packages/shared/src/api/schemas/notes.ts).
      for (const tag of filters.tags) params.append("tags", tag);
    }
    if (filters.attached_to_kind) params.set("attached_to_kind", filters.attached_to_kind);
    if (filters.attached_to_id) params.set("attached_to_id", filters.attached_to_id);
    if (filters.has_attachments !== undefined)
      params.set("has_attachments", String(filters.has_attachments));
    if (filters.cursor) params.set("cursor", filters.cursor);
    if (filters.limit !== undefined) params.set("limit", String(filters.limit));

    const qs = params.toString();
    return this.request(`${this.baseUrl}/api/v1/notes${qs ? `?${qs}` : ""}`, { method: "GET" });
  }

  async update(id: string, body: PatchNoteInput): Promise<Result<Note>> {
    return this.request(`${this.baseUrl}/api/v1/notes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async delete(id: string): Promise<Result<void>> {
    return this.request(`${this.baseUrl}/api/v1/notes/${id}`, { method: "DELETE" });
  }

  // Attachment helpers. `pin` creates a new attachment row tying the note to a
  // (target_kind, target_id) pair. `unpin` deletes by attachment id (so the
  // caller passes both the note id for routing and the attachment id from
  // note.attachments[].id).
  async pin(noteId: string, target: CreateNoteAttachmentInput): Promise<Result<NoteAttachment>> {
    return this.request(`${this.baseUrl}/api/v1/notes/${noteId}/attachments`, {
      method: "POST",
      body: JSON.stringify(target),
    });
  }

  async unpin(noteId: string, attachmentId: string): Promise<Result<void>> {
    return this.request(
      `${this.baseUrl}/api/v1/notes/${noteId}/attachments/${attachmentId}`,
      { method: "DELETE" },
    );
  }

  // GET /api/v1/notes/tags — distinct tags visible to the subject within the
  // project (see apps/api/src/routes/notes/tags.ts). Returns {items: string[]}.
  async tags(projectId: string): Promise<Result<NoteTagsResult>> {
    const params = new URLSearchParams({ project_id: projectId });
    return this.request(`${this.baseUrl}/api/v1/notes/tags?${params.toString()}`, {
      method: "GET",
    });
  }
}

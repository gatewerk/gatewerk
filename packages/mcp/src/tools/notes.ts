import { z } from "zod";
import type { GatewerkClient } from "gatewerk";
import type { ToolDefinition } from "../types.js";
import { toolSuccess, toolError } from "../types.js";

// Wave 2 MCP coverage. Mirrors packages/sdk-ts/src/resources/notes.ts and
// the notes layer mounted by apps/api/src/routes/notes/{read,write,...}.ts.
//
// Scope wiring:
//   - gatewerk_create_note  → notes:write   (declared in @gatewerk/shared)
//   - gatewerk_list_notes   → notes:read    (declared in @gatewerk/shared)
//
// AC #5 (write.ts:44): api_key callers cannot create private notes — backend
// returns api_key_cannot_create_private. We surface is_shared as optional
// with a default of true on the API; we do NOT default it client-side so
// callers see the backend's authoritative behavior + error.
//
// Cross-tenant guard (read.ts:48): api_key callers cannot read notes from a
// different project_id than their key's project. Filtered server-side; surfaced
// here only as a parameter callers must pass (or omit, for api_key callers,
// since the server resolves project_id from the key).

const noteTargetKindSchema = z
  .enum(["review", "template", "chain_run"])
  .describe("Target type the note attaches to");

const attachmentInputSchema = z.object({
  target_kind: noteTargetKindSchema,
  target_id: z.string().describe("Target resource ID (e.g., gw_rev_..., gw_tpl_..., gw_chain_...)"),
});

export function noteTools(client: GatewerkClient): ToolDefinition[] {
  return [
    {
      name: "gatewerk_create_note",
      description:
        "Create a note. api_key callers MUST set is_shared=true (or omit; default is true) — private notes are session-only. Notes can be pinned to one or more review/template/chain_run targets via attachments[].",
      scope: "notes:write",
      schema: {
        body: z.string().describe("Note body (Markdown supported)"),
        tags: z.array(z.string()).optional().describe("Tags for categorization (e.g., ['risk', 'follow-up'])"),
        is_shared: z
          .boolean()
          .optional()
          .describe(
            "Whether the note is visible to other reviewers. Default true. api_key subjects MUST leave true (private notes are session-only).",
          ),
        attachments: z
          .array(attachmentInputSchema)
          .optional()
          .describe("Targets to pin this note to on creation"),
        project_id: z
          .string()
          .optional()
          .describe(
            "Project ID. session callers must pass; api_key callers may omit (server resolves from the key).",
          ),
      },
      handler: async (params) => {
        const { data, error } = await client.notes.create({
          body: params.body,
          tags: params.tags,
          is_shared: params.is_shared,
          attachments: params.attachments,
          project_id: params.project_id,
        });
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
    {
      name: "gatewerk_list_notes",
      description:
        "List notes visible to the caller within a project. Filter by author, tags, target (attached_to_kind + attached_to_id), shared/private, or has_attachments. Supports cursor pagination.",
      scope: "notes:read",
      schema: {
        project_id: z.string().describe("Project ID to scope the listing"),
        author_id: z.string().optional().describe("Filter to notes by a specific author"),
        is_shared: z.boolean().optional().describe("Filter shared (true) or private (false)"),
        tags: z.array(z.string()).optional().describe("Filter to notes that include any of these tags"),
        attached_to_kind: noteTargetKindSchema.optional().describe("Filter to notes pinned to this target kind"),
        attached_to_id: z.string().optional().describe("Filter to notes pinned to this specific target ID"),
        has_attachments: z.boolean().optional().describe("Filter notes that have/lack attachments"),
        cursor: z.string().optional().describe("Pagination cursor from a prior response"),
        limit: z.number().optional().describe("Max results per page"),
      },
      handler: async (params) => {
        const { data, error } = await client.notes.list({
          project_id: params.project_id,
          author_id: params.author_id,
          is_shared: params.is_shared,
          tags: params.tags,
          attached_to_kind: params.attached_to_kind,
          attached_to_id: params.attached_to_id,
          has_attachments: params.has_attachments,
          cursor: params.cursor,
          limit: params.limit,
        });
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
  ];
}

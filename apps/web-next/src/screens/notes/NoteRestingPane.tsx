/**
 * NoteRestingPane — what the detail column shows when no note is selected.
 *
 * History and Templates show a quiet placeholder here. This screen shows the
 * composer instead. That is a DELIBERATE exception to chrome doctrine rule 1:
 * writing a note is the reason to be on
 * this page, so the resting state of the pane is the writing box rather than an
 * instruction to click something. It applies to this screen only. Do not
 * "restore consistency" here casually.
 *
 * The pane is [note column flex-1 | rail
 * 316px], same as NoteDetail's — NoteComposerPane (NoteComposer.tsx) is the
 * shared layout, with the "A NOTE CAN" block passed as `extraMiddle` since
 * it belongs under the fields in the note column, not in the rail.
 *
 * This component owns the create mutation (NoteComposer.tsx's file comment:
 * it never calls the API itself). On save: create the note, then pin it to
 * whatever targets the composer collected, then invalidate the shared
 * ["notes"] query key (same key Notes.tsx and NoteDetail.tsx invalidate on
 * their own mutations), then hand the new note to the caller so it can select
 * it. Disabled while `projectId` has not resolved yet, same guard
 * NoteComposer.tsx and Notes.tsx already apply to their own project-scoped
 * calls.
 *
 * The four lines below are claims about live behaviour, not marketing copy.
 * Each is verified against the shipped product as of this file's commit:
 *   - tags: CreateNoteBodySchema carries `tags`, and Notes.tsx's own tag
 *     filter (`allTags` / `toggleTag` in notes-model.ts) groups notes by tag.
 *   - pin to a template, so every review it makes carries it:
 *     apps/web-next/src/screens/inbox/detail/rail/RailNotes.tsx's
 *     `templateNotesQuery` fetches every note attached to the review's
 *     template and merges it into that review's Notes rail — run once per
 *     review, so a template pin surfaces on every review of that template,
 *     not a fixed page of them. Pinning to a review directly is dropped
 *     from the UI (pin-picker-model.ts's file comment), so this line does
 *     not mention it.
 *   - private or shared with your team AND your agents (not just "the
 *     team", which names something a solo workspace
 *     doesn't have while hiding what the toggle (Just me / Shared, now in
 *     NoteComposerRail.tsx) actually controls): `is_shared` on
 *     CreateNoteBodySchema. `apps/api/src/services/notes-visibility.ts`'s
 *     `noteVisibilityWhere` returns `eq(notes.is_shared, true)` when
 *     `subject_user_id` is null, and `apps/api/src/routes/notes/read.ts:25,154`
 *     sets `subjectUser = subject.kind === "session" ? subject.userId :
 *     null` — an api_key subject (an agent) always resolves to null, so a
 *     shared note is exactly as readable by an agent as by a teammate, no
 *     more and no less. `gatewerk_list_notes`
 *     (packages/mcp/src/tools/notes.ts) is that same read path for an
 *     agent: its handler calls `client.notes.list`, the notes:read route
 *     this predicate gates.
 *   - written by an agent: packages/mcp/src/tools/notes.ts's
 *     `gatewerk_create_note` tool creates a note through the same API.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { notes as notesApi, type Note } from "@gatewerk/web-core/api/notes";
import { mapError, showMappedError } from "@gatewerk/web-core/lib/errors";
import { RulerTickHeader } from "~/components/RulerTickHeader";
import { NoteComposerPane, type ComposerResult } from "./NoteComposer";
import { resolveNoteWriteOutcome } from "./notes-model";

const A_NOTE_CAN = [
  "carry a tag, so everything about refunds sits together",
  "pin to a template, so every review it makes carries it",
  "stay private to you, or shared with your team and your agents",
  "be written by your agent, not just by you",
];

interface Props {
  projectId: string | null;
  onCreated: (note: Note) => void;
}

export function NoteRestingPane({ projectId, onCreated }: Props) {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    // notes.create resolving means the note exists on the server, full stop.
    // Pin attachments are settled rather than awaited with Promise.all so a
    // rejected pin can never make a real note disappear from the mutation's
    // result (fix round 1, Finding 1: an all-or-nothing Promise.all sent a
    // successfully created note straight to onError, with no invalidation
    // and no onCreated, and a retry duplicated it).
    // resolveNoteWriteOutcome (notes-model.ts) is the pure decision of what
    // to tell the user; it never decides whether the note is kept. NoteDetail's
    // edit path calls the same helper, via applyNoteEdit, so both writing
    // paths treat a failed pin identically.
    mutationFn: async (result: ComposerResult) => {
      const newNote = await notesApi.create({
        project_id: projectId as string,
        body: result.body,
        tags: result.tags,
        is_shared: result.is_shared,
      });

      const pinSettlements = await Promise.allSettled(
        result.pins.map((p) => notesApi.pin(newNote.id, { target_kind: p.kind, target_id: p.id })),
      );

      return resolveNoteWriteOutcome(newNote, pinSettlements, "create");
    },
    onSuccess: (outcome) => {
      // Unconditional: the note was created, so it must be reflected on
      // screen regardless of what happened to its pins.
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      if (outcome.toast.kind === "success") {
        toast.success(outcome.toast.message);
      } else {
        toast.error(outcome.toast.message);
      }
      onCreated(outcome.note);
    },
    onError: (e) => showMappedError(mapError(e)),
  });

  return (
    <NoteComposerPane
      projectId={projectId}
      variant="resting"
      saving={createMutation.isPending}
      onSave={(result) => createMutation.mutate(result)}
      extraMiddle={
        <section>
          <RulerTickHeader label="A NOTE CAN" marginClassName="mb-[13px] mt-0" endTick={false} />
          <div className="flex flex-col" style={{ gap: 6 }}>
            {A_NOTE_CAN.map((line) => (
              <p key={line} style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "var(--gw-t7)" }}>
                {line}
              </p>
            ))}
          </div>
        </section>
      }
    />
  );
}

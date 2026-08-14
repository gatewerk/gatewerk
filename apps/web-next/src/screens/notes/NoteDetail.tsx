/**
 * NoteDetail — the note detail pane, [note column flex-1 | rail 316px],
 * copied from the inbox review page's own body row
 * (screens/inbox/detail/ReviewDetail.tsx:76-79: "[PayloadColumn flex-1 |
 * DecisionRail 316px]"). Edit and Delete move
 * off the note column entirely and into the rail, alongside a details
 * section for who wrote the note, when, whether it was edited and whether
 * it is shared — the three fields the old meta line packed into one
 * sentence now read as labelled rows instead (NoteDetailRail.tsx, whose
 * `DetailRow` copies RailDetails.tsx:41-60's row shape).
 *
 * The optional heading (splitNoteHeading, notes-model.ts) now renders in the
 * fixed header band (NoteDetailHeader.tsx) rather than inline above the
 * body — every other detail screen puts a
 * header band above its scrolling body, and Notes was the one screen
 * starting flush against the ceiling. The note column below the band
 * renders ONLY the remainder (`split.body`), never the heading a second
 * time. When a note has no heading, the band's title is instead the note's
 * own first line (noteTitle, notes-model.ts) and `split.body` is exactly
 * `note.body`, so a note without a heading renders the same first line in
 * both places — the same duplication HistoryDetail.tsx's own header/body
 * already accept for getReviewTitle, not a new wart this round introduces.
 * NoteRow.tsx is untouched: the row keeps its current size and appearance
 * untouched.
 *
 * Padding on the note column is copied from HistoryDetail.tsx:173, the same
 * citation this file already carried before this round, so the two detail
 * panes' main columns keep reading as the same rhythm. The band itself
 * copies HistoryDetail.tsx:124-167 (NoteDetailHeader.tsx's own file
 * comment), and the body row below it scrolls independently under the band,
 * exactly as History's two columns do.
 *
 * Edit swaps the whole pane for NoteComposerPane in its "editing" variant
 * rather than lifting edit state to the caller: Task 7's own interface is
 * `<NoteDetail note projectId currentUserId onDeleted />`, with no onEdit,
 * so the swap is local. `updated_at` is read straight off `note` and sent
 * with the patch — the optimistic concurrency token NoteComposer.tsx's file
 * comment describes, never carried by ComposerResult itself. Pins are not
 * part of `patch` either: the composer's returned pins are diffed against
 * `note.attachments` and turned into `notes.pin` / `notes.unpin` calls. An
 * existing note can carry a review or chain run pin from before the
 * template-only ruling (pin-picker-model.ts's file comment); the diff
 * treats those the same as any other pin, it just cannot re-offer them from
 * PinPicker since that picker no longer lists them.
 *
 * The header breadcrumb's pinned segment used to print only the generic
 * kind ("a template") while NotePinCard.tsx, in the
 * rail a few lines below it, resolved and showed the real name. This file is
 * the shared parent of both, so the first attachment's real name is now
 * resolved HERE — via `getReview`/`getTemplate`, the exact same query
 * definitions (same query key) NotePinCard.tsx's own ReviewPinCard /
 * TemplatePinCard call for that same attachment — and handed down to
 * `noteBreadcrumbParts` as `resolvedPinName`. Same query key means React
 * Query serves both call sites off the one cache entry: no second request
 * for the same target, just two subscribers to it. Only the first
 * attachment is resolved (the breadcrumb only ever names one), and a chain
 * run pin is never queried at all — no client can resolve one.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { notes as notesApi, type Note } from "@gatewerk/web-core/api/notes";
import { getReview } from "@gatewerk/web-core/api/reviews";
import { getTemplate } from "@gatewerk/web-core/api/templates";
import { mapError, showMappedError } from "@gatewerk/web-core/lib/errors";
import { getReviewTitle } from "@gatewerk/web-core/lib/utils";
import { applyNoteEdit, noteBreadcrumbParts, noteTitle, splitNoteHeading } from "./notes-model";
import { NoteComposerPane, type ComposerResult } from "./NoteComposer";
import { NoteDetailHeader } from "./NoteDetailHeader";
import { NoteRailShell } from "./NoteRailShell";
import { NoteDetailRail } from "./NoteDetailRail";
import { useNarrowViewport } from "~/shell/use-narrow-viewport";

interface Props {
  note: Note;
  projectId: string | null;
  currentUserId: string | undefined;
  onDeleted: () => void;
}

export function NoteDetail({ note, projectId, currentUserId, onDeleted }: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const queryClient = useQueryClient();
  // On a phone the two body columns (note text, details rail) stack into one
  // scrolling column instead of sitting side by side, the same move as
  // HistoryDetail.tsx: the rail's own width is a fixed 316px with shrink-0,
  // which on a narrow viewport would refuse to shrink and leave the note
  // column a sliver, the min-width trap this plan calls out. Stacking removes
  // the constraint instead of fighting it with a second breakpoint.
  const narrow = useNarrowViewport();

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["notes"] });
  }

  // Patch first, then reconcile attachments against what the composer
  // returned. `patch` never carries attachments (NoteComposer.tsx file
  // comment: "ComposerResult deliberately excludes" the concurrency token,
  // and the server's PatchNoteBodySchema has no attachments field either),
  // so a pin added or removed while editing is its own pair of calls once
  // the body/tags/visibility save succeeds.
  //
  // The whole sequence lives in applyNoteEdit (notes-model.ts) so the rule
  // that makes it safe is testable: only a rejected `patch` may reject the
  // mutation, and the pins are SETTLED rather than awaited together. See that
  // function's comment for what an all-or-nothing Promise.all did to the
  // concurrency token here (fix round 2, Finding 1).
  const saveMutation = useMutation({
    mutationFn: (result: ComposerResult) => applyNoteEdit(notesApi, note, result),
    onSuccess: (outcome) => {
      // Unconditional: the patch landed, so the pane must reflect the server
      // and leave edit mode no matter what happened to the pins. Staying in
      // edit mode would leave a stale `updated_at` in hand and make every
      // later Save from this pane fail as `stale_updated_at`.
      invalidate();
      setIsEditing(false);
      if (outcome.toast.kind === "success") {
        toast.success(outcome.toast.message);
      } else {
        toast.error(outcome.toast.message);
      }
    },
    onError: (e) => showMappedError(mapError(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: () => notesApi.delete(note.id),
    onSuccess: () => {
      invalidate();
      toast.success("Note deleted");
      onDeleted();
    },
    onError: (e) => showMappedError(mapError(e)),
  });

  const unpinMutation = useMutation({
    mutationFn: (attId: string) => notesApi.unpin(note.id, attId),
    onSuccess: () => invalidate(),
    onError: (e) => showMappedError(mapError(e)),
  });

  // The breadcrumb only ever names the FIRST attachment (noteBreadcrumbParts'
  // own comment). Hooks can't be called conditionally, so both queries are
  // always called and `enabled` decides which one, if either, actually
  // fires — same pattern NotePinCard.tsx's ReviewPinCard/TemplatePinCard use
  // for this identical attachment, and the identical query key, so this is
  // one cache entry shared with the rail's card below, not a second fetch.
  const primaryAttachment = note.attachments[0];
  const primaryReviewQuery = useQuery({
    ...getReview({ id: primaryAttachment?.target_id ?? "" }),
    enabled: primaryAttachment?.target_kind === "review",
  });
  const primaryTemplateQuery = useQuery({
    ...getTemplate({ id: primaryAttachment?.target_id ?? "" }),
    enabled: primaryAttachment?.target_kind === "template",
  });
  // undefined while loading, if the target no longer resolves, or for a
  // chain run pin (never queried above — no client can resolve one). The
  // breadcrumb falls back to the generic kind label for all three rather
  // than ever showing a blank or stale name.
  const resolvedPinName =
    primaryAttachment?.target_kind === "review"
      ? primaryReviewQuery.data && getReviewTitle(primaryReviewQuery.data.payload ?? {}, primaryReviewQuery.data.id)
      : primaryAttachment?.target_kind === "template"
        ? primaryTemplateQuery.data?.name
        : undefined;

  if (isEditing) {
    return (
      <NoteComposerPane
        note={note}
        projectId={projectId}
        saving={saveMutation.isPending || deleteMutation.isPending}
        onSave={(result) => saveMutation.mutate(result)}
        onCancel={() => setIsEditing(false)}
        onDelete={() => deleteMutation.mutate()}
        deleting={deleteMutation.isPending}
        variant="editing"
      />
    );
  }

  // Derived, never stored — see notes-model.ts's splitNoteHeading. `body` is
  // exactly `note.body` when there is no heading, so the no-heading render
  // below is byte-identical to what this pane rendered before this round.
  const split = splitNoteHeading(note.body);

  // Shared between the desktop two column body and the phone's stacked one,
  // so the two layouts render the exact same content and only their
  // container changes (HistoryDetail.tsx's own fieldsSection/detailsRail
  // split).
  const bodySection = (
    <>
      <div
        className="whitespace-pre-wrap break-words"
        // Body typography copied from NoteCard.tsx:66-76.
        style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--gw-t3)" }}
      >
        {split.body}
      </div>

      {note.tags.length > 0 && (
        <div className="flex flex-wrap" style={{ gap: 6 }}>
          {note.tags.map((t) => (
            <span
              key={t}
              // Tag chip copied from NoteCard.tsx:82-94.
              className="font-mono"
              style={{
                fontSize: 10.5,
                color: "var(--gw-t7)",
                background: "rgba(var(--gw-line-rgb),.05)",
                borderRadius: 5,
                padding: "2px 7px",
              }}
            >
              #{t}
            </span>
          ))}
        </div>
      )}
    </>
  );

  const railContent = (
    <NoteDetailRail
      note={note}
      currentUserId={currentUserId}
      onEdit={() => setIsEditing(true)}
      onDelete={() => deleteMutation.mutate()}
      deleting={deleteMutation.isPending}
      onUnpin={(attId) => unpinMutation.mutate(attId)}
    />
  );

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <NoteDetailHeader
        title={noteTitle(note.body)}
        breadcrumbParts={noteBreadcrumbParts(note, resolvedPinName)}
      />

      {/* ── Body ── two columns on a laptop, each with its own scroll; one
          stacked, single scrolling column on a phone (see `narrow` above),
          same shape as HistoryDetail.tsx's own body row. */}
      {narrow ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex min-w-0 flex-col" style={{ padding: "24px 30px", gap: 14 }}>
            {bodySection}
          </div>

          {/* Same rail content as the desktop aside, stacked below the note
              text instead of beside it, top border instead of left. */}
          <div
            className="flex min-w-0 flex-col"
            style={{
              borderTop: "1px solid rgba(var(--gw-line-rgb),.07)",
              padding: "20px 22px 24px",
              gap: 24,
            }}
          >
            {railContent}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            className="flex min-w-0 flex-1 flex-col overflow-y-auto"
            // Padding copied from HistoryDetail.tsx:173, the main column's body
            // padding.
            style={{ padding: "24px 30px", gap: 14 }}
          >
            {bodySection}
          </div>

          <NoteRailShell>{railContent}</NoteRailShell>
        </div>
      )}
    </div>
  );
}

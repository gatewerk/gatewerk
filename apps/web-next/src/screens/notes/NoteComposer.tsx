/**
 * NoteComposer — the note form's state and the two panes that render it.
 * One hook, `useNoteComposer`, for two situations: the resting state of the
 * detail pane when nothing is selected (`variant="resting"`, always a fresh
 * note) and editing an existing note in place of its detail view
 * (`variant="editing"`).
 *
 * It never calls the notes API itself. It hands a `ComposerResult` to
 * `onSave` and lets the caller own the mutation, which is what makes one
 * hook correct for both create and edit: NoteRestingPane calls
 * `notes.create`, NoteDetail calls `notes.patch`.
 *
 * The composer never touches `updated_at`. It is not metadata, it is the
 * optimistic concurrency token: the server rejects a patch if the note moved
 * since it was read, so an edit opened in one tab cannot silently overwrite a
 * save made in another. `ComposerResult` deliberately excludes it; the
 * editing caller reads it straight off `note.updated_at` and attaches it when
 * it calls `notes.patch`.
 *
 * The form used to be one component, body field through action buttons,
 * mounted whole in the detail pane. It is now
 * split across the pane's two columns — body + tags in the note column, pin
 * + visibility + actions in the 316px rail (NoteComposerRail.tsx) — so the
 * state has to live above both. `useNoteComposer` is that shared state;
 * `NoteComposerFields` (body + tags) and `NoteComposerPane` (the full
 * [note column | rail] layout, used by both NoteDetail's editing mode and
 * NoteRestingPane's resting mode) are the two things that consume it.
 *
 * This used to render as a centered modal with a backdrop. The redesign
 * mounts it directly in the detail pane, so there is no dialog role, no
 * backdrop, and no click-outside-to-close: Escape and the Cancel button are
 * the only ways to leave edit mode.
 *
 * Field padding, radius, border and background are copied from
 * apps/web-next/src/components/ListSearchField.tsx, the bordered-field
 * reference TagInput and PinPicker already copy from, so the body field reads
 * as one form with the tag field under it rather than two unrelated inputs.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Note } from "@gatewerk/web-core/api/notes";
import { noteTagsQuery } from "~/route-queries";
import { AutoGrowTextarea } from "~/components/AutoGrowTextarea";
import { TagInput } from "./TagInput";
import { pinKindLabel, type PinTarget } from "./pin-picker-model";
import {
  combineNoteBody,
  NOTE_HEADING_MAX_LENGTH,
  noteBreadcrumbParts,
  noteTitle,
  splitNoteHeading,
} from "./notes-model";
import { NoteDetailHeader } from "./NoteDetailHeader";
import { NoteRailShell } from "./NoteRailShell";
import { NoteComposerRail } from "./NoteComposerRail";
import { useNarrowViewport } from "~/shell/use-narrow-viewport";

export type ComposerResult = {
  body: string;
  tags: string[];
  is_shared: boolean;
  pins: PinTarget[];
};

/**
 * An existing note's attachments carry only `target_kind` and `target_id`;
 * there is no client here that can resolve a review or template's real name
 * from an id alone, so the picker's initial chip is labelled by kind, not by
 * a raw id. pinKindLabel is the one shared source for that wording, so the
 * chip and NoteRow's meta line can never say different things about the same
 * pin (pin-picker-model.ts).
 */
function pinsFromNote(note: Note): PinTarget[] {
  return note.attachments.map((a) => ({
    kind: a.target_kind,
    id: a.target_id,
    label: pinKindLabel(a.target_kind),
  }));
}

export interface NoteComposerHandle {
  isEditing: boolean;
  heading: string;
  setHeading: (v: string) => void;
  body: string;
  setBody: (v: string) => void;
  tags: string[];
  setTags: (v: string[]) => void;
  pins: PinTarget[];
  setPins: (v: PinTarget[]) => void;
  isShared: boolean;
  setIsShared: (v: boolean) => void;
  bodyRef: RefObject<HTMLTextAreaElement | null>;
  tagSuggestions: string[];
  canSave: boolean;
  submit: () => void;
}

export function useNoteComposer({
  note,
  projectId,
  saving,
  onSave,
  onCancel,
  variant,
}: {
  /** Absent for a new note. */
  note?: Note;
  projectId: string | null;
  saving: boolean;
  onSave: (result: ComposerResult) => void;
  onCancel?: () => void;
  variant: "resting" | "editing";
}): NoteComposerHandle {
  const isEditing = variant === "editing";

  // Seeded from the note when editing; a fresh, empty draft when resting.
  // `is_shared` defaults to false to match the server's own default
  // (`is_shared: z.boolean().default(false)`).
  //
  // Heading and body are two fields here but ONE column on the server
  // (notes-model.ts's splitNoteHeading/combineNoteBody file comments): an
  // editing note's stored body is split back into the two fields with
  // splitNoteHeading, the exact inverse of what submit() below does with
  // combineNoteBody, so opening a note for editing and saving it again
  // without touching either field round trips byte for byte.
  const initialSplit = note ? splitNoteHeading(note.body) : { heading: null, body: "" };
  const [heading, setHeading] = useState(initialSplit.heading ?? "");
  const [body, setBody] = useState(initialSplit.body);
  const [tags, setTags] = useState<string[]>(note?.tags ?? []);
  const [pins, setPins] = useState<PinTarget[]>(() => (note ? pinsFromNote(note) : []));
  const [isShared, setIsShared] = useState(note?.is_shared ?? false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  // Tag suggestions come from the project's existing tag list, not from
  // TagInput itself: TagInput stays fetch-free and reusable.
  const tagsQuery = useQuery({ ...noteTagsQuery(projectId ?? ""), enabled: !!projectId });
  const tagSuggestions = tagsQuery.data?.items ?? [];

  const hasDraft =
    heading.trim().length > 0 || body.trim().length > 0 || tags.length > 0 || pins.length > 0 || isShared;

  function clearDraft() {
    setHeading("");
    setBody("");
    setTags([]);
    setPins([]);
    setIsShared(false);
  }

  // Escape cancels the nearest thing, once. TagInput and PinPicker each
  // swallow the first Escape (stopPropagation) while their own dropdown is
  // actually VISIBLE on screen — gated by tagDropdownVisible /
  // pinDropdownVisible, not by their internal `open` flag, which goes true
  // on a bare focus before either dropdown renders anything. Because of
  // that, this document-level bubble listener only ever sees an Escape that
  // neither of them had something on screen to close. In editing, that
  // Escape leaves edit mode. At rest, it clears the draft if there is one;
  // with nothing to cancel it is left alone entirely, so it can still reach
  // whatever is above this pane (e.g. dropping out of zen mode).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (isEditing) {
        e.stopPropagation();
        onCancel?.();
        return;
      }
      if (!hasDraft) return;
      e.stopPropagation();
      clearDraft();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isEditing, onCancel, hasDraft]);

  // projectId is required even though the field only reads from `note` or
  // local state: without it `notes.create`/`notes.patch` would fire with a
  // null project_id before the project query resolves, which the server
  // schema rejects (fix round 1, notes-page task 8).
  //
  // Body text alone gates Save — a heading by itself cannot be saved.
  // Requiring body keeps the round trip exact:
  // splitNoteHeading only ever recognises a heading when content follows it,
  // so a heading-only save would come back as `{heading: null, ...}` on
  // reopen and silently demote what was typed into the Heading field to
  // ordinary body text.
  const canSave = body.trim().length > 0 && !saving && !!projectId;

  function submit() {
    if (!canSave) return;
    onSave({ body: combineNoteBody(heading, body.trim()), tags, is_shared: isShared, pins });
  }

  return {
    isEditing,
    heading,
    setHeading,
    body,
    setBody,
    tags,
    setTags,
    pins,
    setPins,
    isShared,
    setIsShared,
    bodyRef,
    tagSuggestions,
    canSave,
    submit,
  };
}

// The implicit "short first line becomes a heading" rule now has a visible
// field to teach it (the Heading input below), so this placeholder no
// longer has to. It stays true either way: a first line
// typed straight into the body, without touching Heading, is still read
// back by the same splitNoteHeading rule.
const NOTE_BODY_PLACEHOLDER = "Write the note.";

/** Heading + body + tags — the note column's half of the form, in both variants. */
export function NoteComposerFields({ composer }: { composer: NoteComposerHandle }) {
  return (
    <div>
      {/* Optional heading, round 4: what used to be taught only by a
          placeholder ("a short first line becomes its heading") is now a
          field of its own. It is NOT a database column — submit() combines
          it with the body into the single first-line-plus-blank-line shape
          splitNoteHeading already knows how to read back
          (combineNoteBody, notes-model.ts). Capped at
          NOTE_HEADING_MAX_LENGTH so the field and the read rule can never
          disagree about what counts as a heading. */}
      <input
        type="text"
        value={composer.heading}
        onChange={(e) => composer.setHeading(e.target.value)}
        placeholder="Heading (optional)"
        aria-label="Note heading"
        maxLength={NOTE_HEADING_MAX_LENGTH}
        // Padding, radius, border and background copied from the body field
        // below, so the two fields read as one stacked form.
        style={{
          width: "100%",
          marginBottom: 8,
          borderRadius: 9,
          padding: "9px 11px",
          background: "rgba(var(--gw-hi-rgb),.03)",
          border: "1px solid rgba(var(--gw-line-rgb),.09)",
          fontFamily: "inherit",
          fontSize: 13.5,
          fontWeight: 600,
          color: "var(--gw-t2)",
          outline: "none",
          boxSizing: "border-box",
        }}
      />

      <AutoGrowTextarea
        ref={composer.bodyRef}
        value={composer.body}
        onChange={(e) => composer.setBody(e.target.value)}
        placeholder={NOTE_BODY_PLACEHOLDER}
        aria-label="Note body"
        // Padding, radius, border and background copied from
        // apps/web-next/src/components/ListSearchField.tsx (the bordered-field
        // reference), the same values TagInput and PinPicker already copy.
        style={{
          width: "100%",
          minHeight: 96,
          borderRadius: 9,
          padding: "9px 11px",
          background: "rgba(var(--gw-hi-rgb),.03)",
          border: "1px solid rgba(var(--gw-line-rgb),.09)",
          fontFamily: "inherit",
          fontSize: 13.5,
          lineHeight: 1.55,
          color: "var(--gw-t2)",
          outline: "none",
          boxSizing: "border-box",
        }}
      />

      <div style={{ marginTop: 12 }}>
        <TagInput value={composer.tags} onChange={composer.setTags} suggestions={composer.tagSuggestions} />
      </div>
    </div>
  );
}

/**
 * The full [note column flex-1 | rail 316px] composer layout, shared by
 * NoteDetail's editing mode and NoteRestingPane's resting mode. `extraMiddle`
 * is the one thing that differs in the note column between the two: the "A
 * NOTE CAN" block, resting only.
 */
export function NoteComposerPane({
  note,
  projectId,
  saving,
  onSave,
  onCancel,
  onDelete,
  deleting,
  variant,
  extraMiddle,
}: {
  note?: Note;
  projectId: string | null;
  saving: boolean;
  onSave: (result: ComposerResult) => void;
  onCancel?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
  variant: "resting" | "editing";
  extraMiddle?: ReactNode;
}) {
  const composer = useNoteComposer({ note, projectId, saving, onSave, onCancel, variant });
  // Same stacking move as NoteDetail.tsx and HistoryDetail.tsx: the rail is a
  // fixed 316px aside that refuses to shrink, so on a phone the two columns
  // stack into one scrolling column instead of leaving the note column a
  // sliver. Covers both variants this pane renders, resting (NoteRestingPane)
  // and editing (NoteDetail), since both mount through here.
  const narrow = useNarrowViewport();

  // Band title/breadcrumb, round 4: creating has no note yet, so "New note"
  // is the honest title rather than deriving one from data that doesn't
  // exist. Editing shows the note's OWN title and breadcrumb — derived from
  // `note.body`/`note` as last saved, not from the live draft in the fields
  // below it — the same choice Inbox's DetailHeader.tsx already makes (its
  // title reads `review.payload`, the original, even while an inline edit is
  // staged in the body below it): the band identifies which record is open,
  // so it stays stable while the fields beneath it change, rather than
  // flickering on every keystroke.
  const band =
    variant === "editing" && note ? (
      <NoteDetailHeader title={noteTitle(note.body)} breadcrumbParts={noteBreadcrumbParts(note)} />
    ) : (
      <NoteDetailHeader title="New note" />
    );

  const railContent = (
    <NoteComposerRail composer={composer} onCancel={onCancel} onDelete={onDelete} deleting={deleting} />
  );

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      {band}

      {/* Two columns on a laptop, each with its own scroll; one stacked,
          single scrolling column on a phone, same shape as NoteDetail.tsx's
          own body row. */}
      {narrow ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex min-w-0 flex-col" style={{ padding: "24px 30px", gap: 32 }}>
            <NoteComposerFields composer={composer} />
            {extraMiddle}
          </div>

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
            // Padding copied from HistoryDetail.tsx:173, same as NoteDetail's
            // own note column. `gap: 32` is the SAME file's own inter-SECTION
            // gap — between its fields
            // `<section>` and `<ActivityTimeline />` — not invented for this
            // screen: `extraMiddle` (the "A NOTE CAN" block, resting only) is
            // exactly that kind of second, separate section beside the form
            // above it, not one more field inside it, so it earns the same
            // gap History already uses between two of its own sections
            // rather than the tighter gap a field stack uses between fields.
            style={{ padding: "24px 30px", gap: 32 }}
          >
            <NoteComposerFields composer={composer} />
            {extraMiddle}
          </div>

          <NoteRailShell>{railContent}</NoteRailShell>
        </div>
      )}
    </div>
  );
}

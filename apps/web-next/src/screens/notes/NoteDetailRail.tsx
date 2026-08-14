/**
 * NoteDetailRail — the right rail for a selected note in VIEW mode.
 *
 * Three sections, top to bottom: Details (who wrote it, when, whether it
 * was edited, whether it's shared), PINNED TO (moved out of the note column
 * — see NoteDetail.tsx's history: three facts crammed into one meta line
 * used to read as a broken sentence; as labelled rows here they read as a
 * details section instead, the same grammar RailDetails.tsx uses for a
 * review), and the actions (Edit, Delete).
 *
 * `DetailRow` copies RailDetails.tsx:41-60's row shape (label 12px t8,
 * value mono right-aligned) rather than importing it — that file doesn't
 * export it.
 *
 * The author avatar keeps PersonAvatar's exact self-view-only contract
 * (PersonAvatar.tsx's own file comment): `userId` is passed ONLY when this
 * note's author is the signed-in reviewer, `null` otherwise, same ternary
 * this pane already used before this round.
 *
 * Delete used to sit behind a "..." menu (NoteDetailMenu.tsx, deleted this
 * round — Delete is a rail action now, nothing else referenced that
 * component). A bare rail button would have made Delete ONE click where it
 * used to be two (open menu, then Delete) — easier to reach, which is
 * deliberately avoided. So Delete arms on its first
 * click (label flips to "Confirm delete") and only fires on a second click;
 * Escape or a 3s idle timeout disarms it without deleting anything. Same
 * arm/confirm timing as screens/review/ExternalReview.tsx's own
 * ARM_TIMEOUT_MS, reused here for the same reason: a destructive action one
 * click away from its own confirmation is not actually behind a menu, but
 * two DELIBERATE clicks is still two clicks, and the visible "Confirm
 * delete" label makes the second one an informed one.
 *
 * The arm/timeout pair by itself leaves no VISIBLE way back — only Escape
 * or a silent 3s wait, with a red button
 * staring at the reader the whole time. ExternalReview.tsx's own mechanic
 * guards a reversible review decision; deleting a note is irreversible, and
 * this app's two precedents for an irreversible confirm
 * (IntegrationsPane.tsx:158-177's Disconnect, DeleteAccountSection.tsx:
 * 190-197) both swap the entire action row into a `[Cancel, Confirm]` pair
 * rather than relying on a timeout alone. The armed state here does the
 * same: Edit is replaced by an explicit Cancel button (tone neutral, same
 * ordering DeleteAccountSection.tsx:191-197 uses — Cancel first, the
 * destructive action last) for exactly as long as Delete stays armed. This
 * also brings the pane in line with NoteComposerRail.tsx, which already
 * has an always-visible Cancel in editing mode.
 *
 * Finding 2: idle order is Edit above Delete — the primary action first,
 * the destructive one last and furthest from where the eye lands, which is
 * the opposite of the neutral→red→green stacking this file cited from
 * RailDecision.tsx before this round. That citation was for tone anatomy
 * (height/radius/colour), not for order; order here is deliberately
 * primary-first per this fix round, not RailDecision's own bottom-loaded
 * primary.
 *
 * `handleDeleteClick` disarms in the same click that starts the delete, so
 * the render right after confirming is already the idle branch, for the
 * whole in-flight window. Without a guard there, a fast enough click could
 * re-arm Delete and fire a second delete for the same note. Which button
 * renders in which state is decided by the pure `noteDetailRailActions`
 * (notes-model.ts) rather than inline JSX conditionals, so the state table
 * has a test that can call it directly. See that function's comment for the
 * full state table, including why Cancel needs no guard — it and an
 * in-flight delete can never coexist in the same render.
 *
 * Idle Edit uses neutral tone, not green. Edit is still first in idle order,
 * but in this app green marks the button that COMMITS — Save, Publish,
 * Create note — and Edit commits nothing; it opens the composer, whose own
 * Save is already green. It uses the same neutral tone as this rail's own
 * armed-state Cancel, so idle Edit and armed Cancel — the two non-committing
 * controls this rail ever shows — read as one tone.
 */
import { useEffect, useState } from "react";
import type { Note } from "@gatewerk/web-core/api/notes";
import { timeAgo } from "@gatewerk/web-core/lib/utils";
import { RulerTickHeader } from "~/components/RulerTickHeader";
import { PersonAvatar } from "~/components/PersonAvatar";
import { ActionButton } from "~/screens/inbox/detail/rail/ActionButton";
import { authorLabel, initials, noteDetailRailActions, noteWasEdited } from "./notes-model";
import { PinnedAttachment } from "./NotePinCard";

const ARM_TIMEOUT_MS = 3_000;

function DetailRow({
  label,
  value,
  valueStyle,
}: {
  label: string;
  value: React.ReactNode;
  valueStyle?: React.CSSProperties;
}) {
  return (
    <div className="flex items-center justify-between" style={{ gap: 12 }}>
      <span className="shrink-0 text-[12px]" style={{ color: "var(--gw-t8)" }}>
        {label}
      </span>
      <span className="font-mono" style={{ fontSize: 11.5, ...valueStyle }}>
        {value}
      </span>
    </div>
  );
}

interface Props {
  note: Note;
  currentUserId: string | undefined;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
  onUnpin: (attachmentId: string) => void;
}

export function NoteDetailRail({ note, currentUserId, onEdit, onDelete, deleting, onUnpin }: Props) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), ARM_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [armed]);

  useEffect(() => {
    if (!armed) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setArmed(false);
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [armed]);

  function handleDeleteClick() {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    onDelete();
  }

  function handleCancelArm() {
    setArmed(false);
  }

  const actions = noteDetailRailActions(armed, deleting);
  const author = authorLabel(note, currentUserId);

  return (
    <>
      <section>
        <RulerTickHeader label="Details" marginClassName="mb-[14px] mt-0" endTick={false} />
        <div className="flex flex-col" style={{ gap: 13 }}>
          {/* Unlabeled avatar row, same grammar as RailDetails.tsx's own
              Assignee row (ActorRow) — a "who" fact doesn't need a label
              beside a face. */}
          <div className="flex items-center" style={{ gap: 9 }}>
            <PersonAvatar
              userId={
                note.author_id && currentUserId && note.author_id === currentUserId
                  ? currentUserId
                  : null
              }
              fallback={initials(author)}
              size={22}
              radius={6}
              background="var(--gw-avatar)"
              border="1px solid rgba(var(--gw-line-rgb),.12)"
              color="var(--gw-t4)"
              fontSize={9.5}
            />
            <span className="font-mono" style={{ fontSize: 11, color: "var(--gw-t9)" }}>
              {author}
            </span>
          </div>

          <DetailRow
            label="Created"
            value={timeAgo(note.created_at)}
            valueStyle={{ fontSize: 12, color: "var(--gw-t4)" }}
          />

          {/* Same rule as the old meta line: only appear when true. Having
              been edited or being shared is a fact worth a row, not being
              either is the default and earns no row at all. */}
          {noteWasEdited(note) && <DetailRow label="Edited" value="Yes" valueStyle={{ color: "var(--gw-t6)" }} />}
          {note.is_shared && <DetailRow label="Visibility" value="Shared" valueStyle={{ color: "var(--gw-t6)" }} />}
        </div>
      </section>

      {/* Only when there is something pinned — RailNotes.tsx's precedent for
          "nothing" is no section at all, not a placeholder line. */}
      {note.attachments.length > 0 && (
        <section>
          <RulerTickHeader label="PINNED TO" marginClassName="mb-[13px] mt-0" endTick={false} />
          <div className="flex flex-col" style={{ gap: 8 }}>
            {note.attachments.map((a) => (
              <PinnedAttachment key={a.id} attachment={a} onUnpin={() => onUnpin(a.id)} />
            ))}
          </div>
        </section>
      )}

      {/* Idle: Edit (primary) above Delete (destructive, furthest from the
          reading path). Armed: the whole row swaps to a self-contained
          confirm step — Cancel then Confirm delete, DeleteAccountSection.tsx:
          190-197's own ordering — rather than leaving Edit next to a red
          button with no visible way back (fix round 1, Finding 1). Which
          buttons render, and whether they're enabled, comes from
          noteDetailRailActions (notes-model.ts) rather than being decided
          here — fix round 2, so the pending-delete guard is one tested
          decision instead of JSX that can silently drop it on one branch. */}
      <section className="flex flex-col gap-2.5">
        {actions.cancel !== "hidden" && <ActionButton label="Cancel" tone="neutral" onClick={handleCancelArm} />}
        {actions.confirmDelete !== "hidden" && (
          <ActionButton
            label="Confirm delete"
            tone="red"
            state={actions.confirmDelete}
            onClick={handleDeleteClick}
          />
        )}
        {actions.edit !== "hidden" && (
          <ActionButton label="Edit" tone="neutral" state={actions.edit} onClick={onEdit} />
        )}
        {actions.delete !== "hidden" && (
          <ActionButton label="Delete" tone="red" state={actions.delete} onClick={handleDeleteClick} />
        )}
      </section>
    </>
  );
}

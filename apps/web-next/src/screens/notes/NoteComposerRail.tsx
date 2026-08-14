/**
 * NoteComposerRail — the right rail while creating or editing a note: the
 * pin control, the visibility toggle, and the write actions (Save, Cancel
 * and Delete when editing an existing note; Create note alone when resting
 * on a fresh one — `onCancel`/`onDelete` are simply absent from the
 * resting caller, NoteComposer.tsx's NoteComposerPane).
 *
 * Action button anatomy (height 42, radius 10, green/red/neutral tones) and
 * stack order — neutral, then red, then green — are copied from
 * screens/inbox/detail/rail/RailDecision.tsx:179-182 and its ActionButton
 * (screens/inbox/detail/rail/ActionButton.tsx), imported directly rather
 * than duplicated: this codebase already imports components cross-screen
 * the same way (PrimaryButton in NoteDetail.tsx's own prior file comment,
 * itself citing screens/settings/NotificationsPane.tsx:31's SelectMenu
 * import as precedent).
 *
 * Delete's reachability: it used to sit behind NoteDetailMenu.tsx's "..."
 * menu (deleted this round — Delete is a rail action now). A bare rail
 * button would make it ONE click where it used to be two, which is
 * deliberately avoided. So the first click arms it
 * (label flips to "Confirm delete"); only a second click, an Escape, or a
 * 3s idle timeout resolves the arm — the same ARM_TIMEOUT_MS timing
 * screens/review/ExternalReview.tsx already uses for its own
 * destructive-decision buttons. NoteDetailRail.tsx's Delete button (the
 * viewing-mode rail) uses the identical mechanic for the identical reason.
 */
import { useEffect, useState } from "react";
import { ActionButton } from "~/screens/inbox/detail/rail/ActionButton";
import { PinPicker } from "./PinPicker";
import type { NoteComposerHandle } from "./NoteComposer";

const ARM_TIMEOUT_MS = 3_000;

interface Props {
  composer: NoteComposerHandle;
  onCancel?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}

export function NoteComposerRail({ composer, onCancel, onDelete, deleting }: Props) {
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
    onDelete?.();
  }

  return (
    <>
      <section>
        <PinPicker value={composer.pins} onChange={composer.setPins} />
      </section>

      <section>
        {/* Visibility toggle — unchanged control, background/border/typography
            all copied from the old composer's inline version, just relocated
            from the note column into the rail.
            Fix round 2 (2026-08-09): the second option's label was "The
            team", but notes-visibility.ts's own noteVisibilityWhere shows
            this toggle does not decide "team versus me" — an api_key
            subject (an agent, see packages/mcp/src/tools/notes.ts's
            gatewerk_list_notes) can read a note iff it is shared, full
            stop, same as a teammate. "The team" named something a solo
            workspace doesn't have while hiding what the toggle actually
            controls. "Shared" matches the list's own Shared tab
            (VISIBILITY_TABS, notes-model.ts) and is true regardless of
            headcount. */}
        <div
          role="group"
          aria-label="Who can see this note"
          className="inline-flex"
          style={{
            gap: 1,
            padding: 3,
            borderRadius: 9,
            background: "rgba(var(--gw-hi-rgb),.03)",
            border: "1px solid rgba(var(--gw-line-rgb),.08)",
          }}
        >
          {(
            [
              { label: "Just me", value: false },
              { label: "Shared", value: true },
            ] as const
          ).map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => composer.setIsShared(o.value)}
              aria-pressed={composer.isShared === o.value}
              className="cursor-pointer border-none"
              style={{
                padding: "5px 13px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: composer.isShared === o.value ? 600 : 500,
                fontFamily: "inherit",
                background: composer.isShared === o.value ? "rgba(var(--gw-hi-rgb),.1)" : "transparent",
                color: composer.isShared === o.value ? "var(--gw-t2)" : "var(--gw-t7)",
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        {composer.isEditing && onCancel && <ActionButton label="Cancel" tone="neutral" onClick={onCancel} />}
        {composer.isEditing && onDelete && (
          <ActionButton
            label={armed ? "Confirm delete" : "Delete"}
            tone="red"
            state={deleting ? "loading" : "idle"}
            onClick={handleDeleteClick}
          />
        )}
        <ActionButton
          label={composer.isEditing ? "Save" : "Create note"}
          tone="green"
          state={composer.canSave ? "idle" : "disabled"}
          onClick={composer.submit}
        />
      </section>
    </>
  );
}

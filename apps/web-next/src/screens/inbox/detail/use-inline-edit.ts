/**
 * use-inline-edit — "just the line" primitive (Notion-style).
 *
 * No input chrome. ⌘↵ commits. Esc cancels + restores pre-edit snapshot.
 * Escape stopPropagation prevents it from also exiting zen mode
 * (Escape-cancel priority: inline edit > zen).
 *
 * Blur also commits (leaving the field must never silently discard a typed
 * draft — clicking away, tabbing out, or clicking Approve all count).
 * A changed draft commits on blur; an unchanged one just closes the editor.
 */
import { useCallback, useRef, useState } from "react";

export interface InlineEditHandle {
  /** True while the field is being edited. */
  editing: boolean;
  /** Current draft value (while editing) or null. */
  draft: string;
  /** Call when the user activates the editable area. */
  startEdit: (currentValue: string) => void;
  /** Update the in-progress draft (on input/change events). */
  updateDraft: (value: string) => void;
  /** Commit handler — call on ⌘↵ keydown. */
  commit: () => void;
  /** Cancel handler — call on Esc keydown. Stops propagation on the event. */
  cancel: (e?: Pick<KeyboardEvent, "stopPropagation">) => void;
  /** KeyDown handler wiring ⌘↵ = commit, Esc = cancel. */
  handleKeyDown: (e: React.KeyboardEvent) => void;
  /** Blur handler — commits a changed draft, otherwise just closes the editor. */
  handleBlur: () => void;
}

/**
 * @param onCommit  called with the committed string value.
 * @param onCancel  called when edit is cancelled (optional).
 */
export function useInlineEdit(
  onCommit: (value: string) => void,
  onCancel?: () => void,
): InlineEditHandle {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const snapshotRef = useRef("");
  // Mirrors `editing`, but readable synchronously inside the blur handler.
  // Commit and cancel both flip it false immediately, before React has had
  // a chance to re-render — so a blur that lands in the same synchronous
  // stretch of work right after a Cmd+Enter commit or an Escape cancel sees
  // it and no-ops, instead of relying on the field having already unmounted
  // (event order is not guaranteed; a stale-closure `editing` read would be).
  const activeRef = useRef(false);

  const startEdit = useCallback((currentValue: string) => {
    snapshotRef.current = currentValue;
    setDraft(currentValue);
    setEditing(true);
    activeRef.current = true;
  }, []);

  const updateDraft = useCallback((value: string) => {
    setDraft(value);
  }, []);

  const commit = useCallback(() => {
    activeRef.current = false;
    setEditing(false);
    onCommit(draft);
  }, [draft, onCommit]);

  const cancel = useCallback(
    (e?: Pick<KeyboardEvent, "stopPropagation">) => {
      e?.stopPropagation(); // do not let Esc bubble to zen-mode handler
      activeRef.current = false;
      setDraft(snapshotRef.current);
      setEditing(false);
      onCancel?.();
    },
    [onCancel],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        cancel(e.nativeEvent);
      }
    },
    [commit, cancel],
  );

  const handleBlur = useCallback(() => {
    if (!activeRef.current) return; // already committed or cancelled — do not act twice
    if (draft !== snapshotRef.current) {
      commit();
    } else {
      activeRef.current = false;
      setEditing(false);
    }
  }, [draft, commit]);

  return { editing, draft, startEdit, updateDraft, commit, cancel, handleKeyDown, handleBlur };
}

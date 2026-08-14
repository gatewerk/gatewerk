/**
 * use-edited-payload — local staging for per-field edits.
 *
 * Keys by field.name. Values are staged in React state for rendering, and
 * mirrored onto a ref for synchronous reads. No server calls (setDraft/decide
 * are owned by 3c).
 *
 * Why the ref mirror: an inline edit can commit via blur (see
 * use-inline-edit.ts), and blur fires before click — so clicking Approve
 * while a field is still focused commits that field's draft a moment before
 * the decide handler runs, in the same synchronous stretch of work. `staged`
 * (useState) only reflects that commit after React re-renders, which the
 * decide handler's own click callback does not wait for. `getStaged()` reads
 * the ref instead, updated in `set`/`revert`/`clear` themselves rather than
 * only inside the `setStaged` updater, so it is current the instant the
 * commit happens — no flushSync required.
 */
import { useState, useCallback, useRef } from "react";

export interface EditedPayloadHandle {
  /** Current staged value for a field (or undefined if not yet edited). */
  get: (name: string) => unknown;
  /** Stage an edit. Pass the original value to auto-clear when identical. */
  set: (name: string, value: unknown, original: unknown) => void;
  /** Remove the staged edit for a field, reverting to original. */
  revert: (name: string) => void;
  /** True if the field has a staged edit. */
  has: (name: string) => boolean;
  /** Clear all staged edits (on review change). */
  clear: () => void;
  /** The full staged map (for decision rail in 3c). Reactive — for rendering. */
  staged: ReadonlyMap<string, unknown>;
  /**
   * Synchronous read of the full staged map. Always current, even for a
   * commit that happened moments ago in the same synchronous stretch of
   * work and hasn't re-rendered yet. Decide handlers must read this, not
   * `staged`, at submit time.
   */
  getStaged: () => ReadonlyMap<string, unknown>;
}

export function useEditedPayload(): EditedPayloadHandle {
  const [staged, setStaged] = useState<Map<string, unknown>>(new Map());
  const stagedRef = useRef<Map<string, unknown>>(staged);

  const get = useCallback((name: string): unknown => staged.get(name), [staged]);

  const set = useCallback(
    (name: string, value: unknown, original: unknown) => {
      const next = new Map(stagedRef.current);
      if (JSON.stringify(value) === JSON.stringify(original)) {
        next.delete(name);
      } else {
        next.set(name, value);
      }
      stagedRef.current = next;
      setStaged(next);
    },
    [],
  );

  const revert = useCallback((name: string) => {
    const next = new Map(stagedRef.current);
    next.delete(name);
    stagedRef.current = next;
    setStaged(next);
  }, []);

  const has = useCallback((name: string): boolean => staged.has(name), [staged]);

  const clear = useCallback(() => {
    const next = new Map<string, unknown>();
    stagedRef.current = next;
    setStaged(next);
  }, []);

  const getStaged = useCallback((): ReadonlyMap<string, unknown> => stagedRef.current, []);

  return { get, set, revert, has, clear, staged, getStaged };
}

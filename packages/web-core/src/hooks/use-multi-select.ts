import { useState, useCallback, useRef } from "react";

interface Item {
  id: string;
}

export interface UseMultiSelectResult {
  /** Set of multi-selected ids. Empty = not in multi-select mode. */
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** True when at least one item is multi-selected. */
  isMultiSelectMode: boolean;
  /** Toggle one id in the selection. Manages selectedId clearing. */
  toggleMultiSelect: (id: string) => void;
  /** Handles plain / Cmd-click / Shift-click row interactions. */
  handleRowClick: (id: string, e: React.MouseEvent) => void;
  /** Drop multi-selection without changing selectedId. */
  clearSelection: () => void;
  /** Multi-select every id in the current items list. */
  selectAll: () => void;
}

/**
 * Shared list-row selection behavior used by Inbox, History, and Templates.
 *
 * The hook owns the multi-selection state and click-coordination logic. The
 * page owns single-select `selectedId` (because it's referenced in many other
 * effects and keyboard handlers); the hook receives it as a controlled value.
 *
 * Click model:
 *   - Plain click — single-select detail focus, drops any multi-selection
 *   - Cmd/Ctrl+click — toggle id, enter multi-select
 *   - Shift+click — range-select from last clicked to current
 *   - Plain click while in multi-select mode — toggle (no Cmd needed)
 *
 * Removing the last item from the multi-set re-selects it for detail view —
 * users dropping back to "just one" expect to see its detail, not an empty pane.
 *
 * `items` is read via a ref at click time so the click handler always sees
 * the current filtered list (not whatever was captured when the callback was
 * memoized).
 */
export function useMultiSelect<T extends Item>(
  items: T[],
  selectedId: string | null,
  setSelectedId: (id: string | null) => void
): UseMultiSelectResult {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);

  // Read fresh each click — avoids stale closures over the filtered list.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const isMultiSelectMode = selectedIds.size > 0;

  const toggleMultiSelect = useCallback(
    (id: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
          if (next.size === 0) {
            setSelectedId(id);
            return next;
          }
        } else {
          next.add(id);
        }
        setSelectedId(null);
        return next;
      });
      setLastClickedId(id);
    },
    [setSelectedId]
  );

  const handleRowClick = useCallback(
    (id: string, e: React.MouseEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;

      if (isMeta) {
        toggleMultiSelect(id);
      } else if (isShift && lastClickedId) {
        setSelectedId(null);
        const list = itemsRef.current;
        const startIdx = list.findIndex((it) => it.id === lastClickedId);
        const endIdx = list.findIndex((it) => it.id === id);
        if (startIdx !== -1 && endIdx !== -1) {
          const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          const rangeIds = list.slice(from, to + 1).map((it) => it.id);
          setSelectedIds((prev) => {
            const next = new Set(prev);
            rangeIds.forEach((rid) => next.add(rid));
            return next;
          });
        }
      } else if (isMultiSelectMode) {
        toggleMultiSelect(id);
      } else {
        const current = selectedIdRef.current;
        setSelectedId(current === id ? null : id);
        setSelectedIds(new Set());
        setLastClickedId(id);
      }
    },
    [isMultiSelectMode, lastClickedId, setSelectedId, toggleMultiSelect]
  );

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(itemsRef.current.map((it) => it.id)));
  }, []);

  return {
    selectedIds,
    setSelectedIds,
    isMultiSelectMode,
    toggleMultiSelect,
    handleRowClick,
    clearSelection,
    selectAll,
  };
}

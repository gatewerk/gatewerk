/**
 * BulkBar — docked glass bar at the list bottom in select mode.
 *
 * "N selected" + Archive + Delete (with confirm) + close (X).
 * Actions = real endpoints: reviews.bulkArchive / reviews.bulkDelete.
 * Delete confirms with a window.confirm before firing.
 * Each fires a sonner count toast on success.
 * Appears with gw-toast-in animation (opacity + 10px rise).
 */
import { X, Archive, Trash2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reviews } from "@gatewerk/web-core/api/reviews";

interface Props {
  selectedIds: Set<string>;
  onClose: () => void;
}

export function BulkBar({ selectedIds, onClose }: Props) {
  const count = selectedIds.size;
  const queryClient = useQueryClient();

  const archiveMutation = useMutation({
    mutationFn: (ids: string[]) => reviews.bulkArchive(ids),
    onSuccess: (data) => {
      const n = data.count ?? count;
      toast.success(`${n} ${n === 1 ? "review" : "reviews"} archived`);
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Archive failed");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: string[]) => reviews.bulkDelete(ids),
    onSuccess: (data) => {
      const n = data.count ?? count;
      toast.success(`${n} ${n === 1 ? "review" : "reviews"} deleted`);
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    },
  });

  function handleArchive() {
    if (count === 0) return;
    archiveMutation.mutate([...selectedIds]);
  }

  function handleDelete() {
    if (count === 0) return;
    const confirmed = window.confirm(
      `Delete ${count} ${count === 1 ? "review" : "reviews"}? This cannot be undone.`,
    );
    if (!confirmed) return;
    deleteMutation.mutate([...selectedIds]);
  }

  const isBusy = archiveMutation.isPending || deleteMutation.isPending;

  return (
    <div
      className="flex shrink-0 items-center gap-2 rounded-[10px] px-3 py-2.5"
      style={{
        margin: "0 8px 10px",
        background: "rgba(34,34,30,.82)",
        backdropFilter: "blur(20px) saturate(145%)",
        WebkitBackdropFilter: "blur(20px) saturate(145%)",
        border: "1px solid rgba(240,240,220,.14)",
        boxShadow:
          "0 8px 24px rgba(0,0,0,.45), inset 0 1px 0 rgba(240,240,220,.09)",
        animation: "gw-toast-in .2s ease both",
      }}
    >
      {/* Count badge */}
      <span
        className="flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5 font-mono text-[11px] font-semibold tabular-nums"
        style={{
          background: "rgba(var(--gw-line-rgb),.14)",
          color: "var(--gw-t4)",
        }}
      >
        {count}
      </span>

      <span className="text-[12px] font-medium" style={{ color: "var(--gw-t5)" }}>
        {count === 1 ? "review" : "reviews"} selected
      </span>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Archive */}
      <button
        onClick={handleArchive}
        disabled={isBusy || count === 0}
        className="flex h-[26px] items-center gap-1.5 rounded-[7px] px-2.5 text-[11px] font-semibold transition-colors disabled:opacity-40"
        style={{
          background: "rgba(var(--gw-line-rgb),.10)",
          border: "1px solid rgba(var(--gw-line-rgb),.12)",
          color: "var(--gw-t5)",
          cursor: isBusy || count === 0 ? "not-allowed" : "pointer",
        }}
        title={`Archive ${count} selected`}
      >
        <Archive size={12} strokeWidth={1.8} />
        Archive
      </button>

      {/* Delete */}
      <button
        onClick={handleDelete}
        disabled={isBusy || count === 0}
        className="flex h-[26px] items-center gap-1.5 rounded-[7px] px-2.5 text-[11px] font-semibold transition-colors disabled:opacity-40"
        style={{
          background: "rgba(var(--gw-red-rgb),.08)",
          border: "1px solid rgba(var(--gw-red-rgb),.22)",
          color: "var(--gw-red-t)",
          cursor: isBusy || count === 0 ? "not-allowed" : "pointer",
        }}
        title={`Delete ${count} selected`}
      >
        <Trash2 size={12} strokeWidth={1.8} />
        Delete
      </button>

      {/* Close / exit select mode */}
      <button
        onClick={onClose}
        className="ml-1 flex h-[26px] w-[26px] items-center justify-center rounded-[7px] transition-colors"
        style={{
          background: "transparent",
          border: "none",
          color: "var(--gw-t8)",
          cursor: "pointer",
        }}
        title="Exit select mode"
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

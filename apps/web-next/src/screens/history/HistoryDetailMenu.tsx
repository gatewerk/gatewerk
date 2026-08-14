/**
 * HistoryDetailMenu — the "..." menu on a resolved record: export it, or
 * archive/unarchive it. No Delete: History is the audit trail, and a
 * decided review gets hidden via
 * Archive, never permanently destroyed — apps/web's version had a real,
 * confirm-gated permanent delete, deliberately not carried over.
 *
 * Archive/unarchive logic and export shape ported from apps/web's
 * pages/history/{DetailMenu,use-history-archive-actions,export-helpers}.tsx,
 * simplified to the single-record case (that menu also handled bulk
 * selection, which History.tsx's own file doc marks as not built here).
 *
 * Popover chrome matches the app's one floating-layer language (glass .74,
 * blur(18) sat(140%), radius 11 — same as DateRangePopover / ActionFilterMenu).
 */
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Download, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { archiveReview, unarchiveReview, type Review } from "@gatewerk/web-core/api/reviews";
import { downloadFile, getReviewTitle } from "@gatewerk/web-core/lib/utils";

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

function exportName(review: Review, ext: string): string {
  return `gatewerk-${slugify(getReviewTitle(review.payload, review.id))}.${ext}`;
}

function exportCSV(review: Review) {
  const headers = ["ID", "Title", "Decision", "Reviewer", "Template", "Date", "Feedback"];
  const row = [
    review.id,
    `"${getReviewTitle(review.payload, review.id).replace(/"/g, '""')}"`,
    review.decision ?? "",
    review.decided_by ?? "",
    review.template_slug ?? "",
    review.decided_at ?? "",
    `"${(review.feedback ?? "").replace(/"/g, '""')}"`,
  ];
  downloadFile([headers.join(","), row.join(",")].join("\n"), exportName(review, "csv"), "text/csv");
  toast.success("Exported as CSV");
}

function exportJSON(review: Review) {
  downloadFile(JSON.stringify(review, null, 2), exportName(review, "json"), "application/json");
  toast.success("Exported as JSON");
}

export function HistoryDetailMenu({ review }: { review: Review }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const isArchived = review.status === "archived";

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  const archiveMutation = useMutation({
    mutationFn: () =>
      isArchived ? unarchiveReview({ id: review.id }) : archiveReview({ id: review.id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["reviews"] });
      if (isArchived) {
        toast.success("Review restored");
        return;
      }
      // Undo mirrors apps/web's Linear-style pattern: a direct follow-up
      // call from the toast action, not routed back through this mutation
      // (the toast has already dismissed the "archiving" state by then).
      toast.success("Review archived", {
        action: {
          label: "Undo",
          onClick: () => {
            unarchiveReview({ id: review.id }).then(() => {
              void queryClient.invalidateQueries({ queryKey: ["reviews"] });
              toast.success("Review restored");
            });
          },
        },
      });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Request failed");
    },
  });

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Record actions"
        onClick={() => setOpen((o) => !o)}
        className={
          open
            ? "flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-[8px] border-none bg-[rgba(var(--gw-line-rgb),0.10)] text-t2 transition-colors"
            : "flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-[8px] border-none bg-transparent text-t8 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)] hover:text-t4"
        }
      >
        <MoreHorizontal size={16} strokeWidth={1.8} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[39]" onClick={() => setOpen(false)} />
          <div
            role="menu"
            aria-label="Record actions"
            className="absolute right-0 z-[40] mt-1 flex flex-col"
            style={{
              width: 176,
              padding: 5,
              background: "rgba(var(--gw-glass-rgb),.74)",
              backdropFilter: "blur(18px) saturate(140%)",
              WebkitBackdropFilter: "blur(18px) saturate(140%)",
              border: "1px solid rgba(var(--gw-line-rgb),.14)",
              borderRadius: 11,
              boxShadow: "0 18px 44px rgba(0,0,0,.5), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
            }}
          >
            <MenuItem
              icon={<Download size={13} strokeWidth={1.8} />}
              label="Export CSV"
              onClick={() => {
                setOpen(false);
                exportCSV(review);
              }}
            />
            <MenuItem
              icon={<Download size={13} strokeWidth={1.8} />}
              label="Export JSON"
              onClick={() => {
                setOpen(false);
                exportJSON(review);
              }}
            />
            <div style={{ height: 1, background: "rgba(var(--gw-line-rgb),.08)", margin: "4px 6px" }} />
            <MenuItem
              icon={
                isArchived ? (
                  <ArchiveRestore size={13} strokeWidth={1.8} />
                ) : (
                  <Archive size={13} strokeWidth={1.8} />
                )
              }
              label={isArchived ? "Unarchive" : "Archive"}
              disabled={archiveMutation.isPending}
              onClick={() => {
                setOpen(false);
                archiveMutation.mutate();
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-[9px] rounded-[7px] border-none bg-transparent px-2.5 py-[7px] text-left text-[12px] transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)] disabled:cursor-not-allowed disabled:opacity-50"
      style={{ color: "var(--gw-t4)" }}
    >
      <span style={{ color: "var(--gw-t8)" }}>{icon}</span>
      {label}
    </button>
  );
}

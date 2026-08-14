/**
 * Detail header: title, mono meta strip, overflow menu.
 * Same proportions as the inbox review header so the two panes line up.
 */
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Trash2 } from "lucide-react";
import type { TemplateSchema } from "@gatewerk/shared";
import { IconButton } from "../_ui";

/**
 * Publish, Discard, Edit and the active/inactive toggle deliberately live in
 * the rail, not here: the rail is where the operator already is when they
 * finish editing, and splitting the lifecycle across two corners of the pane
 * is how a Save button gets missed. The header owns identity and Delete only.
 */
interface Props {
  template: TemplateSchema;
  name: string;
  slug: string;
  isEditing: boolean;
  onDelete: () => void;
}

export function DetailHeader({ template, name, slug, isEditing, onDelete }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      setConfirmDelete(false);
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [menuOpen]);

  const status = template.status ?? "active";
  const statusWord = status === "draft" ? "draft" : status === "inactive" ? "inactive" : "published";

  return (
    <div
      className="shrink-0"
      style={{ padding: "20px 28px 15px", borderBottom: "1px solid rgba(var(--gw-line-rgb),.07)" }}
    >
      <div className="flex items-center" style={{ gap: 13 }}>
        <h1
          className="min-w-0 flex-1 truncate font-display text-[23px] font-semibold leading-tight"
          style={{ letterSpacing: "-.015em", color: "var(--gw-t1)" }}
        >
          {name || "Untitled template"}
        </h1>

        <div ref={rootRef} className="relative shrink-0">
          <IconButton
            title="More"
            size={32}
            active={menuOpen}
            onClick={() => {
              setMenuOpen((o) => !o);
              setConfirmDelete(false);
            }}
          >
            <MoreHorizontal size={16} />
          </IconButton>

          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-[39]"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmDelete(false);
                }}
              />
              <div
                className="absolute right-0 z-[40] mt-1 flex flex-col gap-px p-1.5"
                style={{
                  top: "100%",
                  width: 232,
                  background: "rgba(var(--gw-modal-rgb),.96)",
                  backdropFilter: "blur(18px) saturate(140%)",
                  WebkitBackdropFilter: "blur(18px) saturate(140%)",
                  border: "1px solid rgba(var(--gw-line-rgb),.14)",
                  borderRadius: 11,
                  boxShadow: "0 18px 44px rgba(0,0,0,.5), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
                }}
              >
                {confirmDelete ? (
                  <div className="flex flex-col gap-2 px-2.5 py-2">
                    <span className="text-[12px] leading-relaxed" style={{ color: "var(--gw-t5)" }}>
                      Delete {template.name || "this template"}? This cannot be undone.
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          setConfirmDelete(false);
                          onDelete();
                        }}
                        className="flex h-7 flex-1 cursor-pointer items-center justify-center rounded-[7px] border-none text-[11.5px] font-semibold transition-opacity hover:opacity-85"
                        style={{ background: "rgba(var(--gw-red-rgb),.16)", color: "var(--gw-red-t)" }}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                        className="flex h-7 flex-1 cursor-pointer items-center justify-center rounded-[7px] bg-transparent text-[11.5px] font-medium transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)]"
                        style={{ border: "1px solid rgba(var(--gw-line-rgb),.12)", color: "var(--gw-t5)" }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="flex cursor-pointer items-center gap-2.5 rounded-[7px] border-none bg-transparent px-2.5 py-2 text-left text-[12.5px] transition-colors hover:bg-[rgba(var(--gw-red-rgb),0.08)]"
                    style={{ color: "var(--gw-red-t)" }}
                  >
                    <Trash2 size={13} strokeWidth={1.9} />
                    Delete
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div
        className="flex items-center gap-[9px] font-mono text-[11.5px]"
        style={{ marginTop: 9, color: "var(--gw-t8)" }}
      >
        <span className="truncate">{slug || "no slug yet"}</span>
        <span style={{ color: "var(--gw-t11)" }}>/</span>
        <span>{isEditing ? "editing" : statusWord}</span>
      </div>
    </div>
  );
}

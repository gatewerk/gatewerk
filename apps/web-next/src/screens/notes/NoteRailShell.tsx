/**
 * NoteRailShell — the 316px right rail container shared by all three note
 * detail-pane states (viewing, editing, resting/create).
 *
 * Copied verbatim from DecisionRail.tsx:25-37
 * (screens/inbox/detail/rail/DecisionRail.tsx): width, left hairline,
 * padding and inter-section gap, so a note's rail reads as the same object
 * as a review's. "Sections are separated by whitespace ONLY" is that file's
 * own comment for this block — the shell provides padding + gap, sections
 * carry no borders of their own, and callers pass sections as children.
 */
import type { ReactNode } from "react";

export function NoteRailShell({ children }: { children: ReactNode }) {
  return (
    <aside
      className="flex h-full flex-col overflow-y-auto overflow-x-hidden"
      style={{
        width: 316,
        minWidth: 316,
        maxWidth: 316,
        borderLeft: "1px solid rgba(var(--gw-line-rgb),.07)",
        flexShrink: 0,
        padding: "24px 22px",
        gap: 24,
      }}
    >
      {children}
    </aside>
  );
}

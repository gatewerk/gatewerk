/**
 * NoteDetailHeader — the fixed header band above a note's detail area,
 * shared by the read pane (NoteDetail.tsx) and both composer states
 * (NoteComposer.tsx's NoteComposerPane, resting and editing). Copied from
 * HistoryDetail.tsx:124-167: `shrink-0`, the same padding
 * ("20px 30px 16px"), the same bottom border
 * (rgba(var(--gw-line-rgb),.07)), the same h1 (font-display, 23px/600,
 * letterSpacing -0.015em, truncating) and the same breadcrumb (font-mono
 * 11.5px, color var(--gw-t8), gap 9, marginTop 10, a dedicated "/" span at
 * var(--gw-t11) rather than spacing alone) — so a note's detail area reads
 * as the same rhythm as every other detail screen instead of starting flush
 * against the ceiling.
 *
 * Unlike HistoryDetail's own band, no actions render here: Edit, Delete and
 * the rest stay in the rail (NoteDetailRail.tsx / NoteComposerRail.tsx),
 * not duplicated into the header. A note's
 * band is header text only, so there is no title row wrapping an
 * icon button — just the h1 directly.
 *
 * `breadcrumbParts` is omitted entirely (no row at all) rather than
 * rendered empty when absent or empty — NoteComposerPane's resting/creating
 * state has nothing true to report yet, and an empty breadcrumb row would
 * read as a broken control rather than an absent one, the same reasoning
 * HistoryDetail.tsx applies to its rail's Callback row.
 */
import { Fragment } from "react";

interface Props {
  title: string;
  breadcrumbParts?: string[];
}

export function NoteDetailHeader({ title, breadcrumbParts }: Props) {
  return (
    <div
      className="shrink-0"
      style={{
        padding: "20px 30px 16px",
        borderBottom: "1px solid rgba(var(--gw-line-rgb),.07)",
      }}
    >
      <h1
        className="truncate font-display"
        style={{
          margin: 0,
          fontSize: 23,
          fontWeight: 600,
          letterSpacing: "-0.015em",
          color: "var(--gw-t1)",
        }}
      >
        {title}
      </h1>

      {breadcrumbParts && breadcrumbParts.length > 0 && (
        <div
          className="flex items-center font-mono"
          style={{ gap: 9, marginTop: 10, fontSize: 11.5, color: "var(--gw-t8)" }}
        >
          {breadcrumbParts.map((part, i) => (
            <Fragment key={part}>
              {i > 0 && (
                <span className="shrink-0" style={{ color: "var(--gw-t11)" }}>
                  /
                </span>
              )}
              <span className={i === 0 ? "min-w-0 truncate" : "shrink-0"}>{part}</span>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

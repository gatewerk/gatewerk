/**
 * RailNotes — Zone 4 §3: read-only note cards.
 *
 * Source: the standalone Notes system (the Notes page) — notes ATTACHED to
 * this review PLUS notes attached to the review's TEMPLATE (a note pinned
 * to a template surfaces on every review of that template). "thread"-tagged
 * notes are EXCLUDED — those are the Activity thread's replies. Shares the
 * review-attached query (and cache) with ActivityThread.
 * SHARED (blue) / PRIVATE (amber) come from the note's real is_shared flag.
 *
 * When there are no notes, the SECTION DOES NOT RENDER AT ALL — no header,
 * no "No notes yet" placeholder.
 */
import { useQuery } from "@tanstack/react-query";
import { notes as notesApi } from "@gatewerk/web-core/api/notes";
import { timeAgo } from "@gatewerk/web-core/lib/utils";
import { RulerTickHeader } from "~/components/RulerTickHeader";
import { attachedNotesQuery, THREAD_TAG } from "../ActivityThread";

interface Props {
  reviewId: string;
  projectId: string;
  templateId: string | null;
}

export function RailNotes({ reviewId, projectId, templateId }: Props) {
  const reviewNotesQuery = useQuery(attachedNotesQuery(projectId, reviewId));
  const templateNotesQuery = useQuery({
    queryKey: ["notes", "attached", "template", templateId],
    queryFn: () =>
      notesApi.list({
        project_id: projectId,
        limit: 50,
        attached_to_kind: "template",
        attached_to_id: templateId ?? "",
      }),
    enabled: !!templateId,
    staleTime: 30_000,
  });

  const merged = [
    ...(reviewNotesQuery.data?.items ?? []),
    ...(templateNotesQuery.data?.items ?? []),
  ];
  const seen = new Set<string>();
  const notes = merged
    .filter((n) => !n.tags.includes(THREAD_TAG))
    .filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))
    .sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

  // No notes → no section at all.
  if (notes.length === 0) return null;

  return (
    <section>
      <RulerTickHeader label="Notes" marginClassName="mb-[13px] mt-0" endTick={false} />

      <div className="flex flex-col" style={{ gap: 10 }}>
          {notes.map((note) => {
            const isPrivate = !note.is_shared;
            const badgeColor = isPrivate ? "var(--gw-amber-t)" : "var(--gw-blue-t)";

            return (
              <div
                key={note.id}
                style={{
                  background: "rgba(var(--gw-line-rgb),.02)",
                  border: isPrivate
                    ? "1px solid rgba(var(--gw-amber-rgb),.2)"
                    : "1px solid rgba(var(--gw-line-rgb),.08)",
                  borderRadius: 9,
                  padding: "10px 11px",
                }}
              >
                <div className="flex items-center" style={{ gap: 7, marginBottom: 5 }}>
                  {/* Badge: colored dot + tracked mono label — never a bordered pill (spec §5b) */}
                  <span
                    className="inline-flex items-center font-mono uppercase"
                    style={{
                      gap: 6,
                      fontSize: 9,
                      fontWeight: 600,
                      letterSpacing: ".08em",
                      color: badgeColor,
                    }}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background: badgeColor,
                        flexShrink: 0,
                      }}
                    />
                    {isPrivate ? "Private" : "Shared"}
                  </span>
                  <span className="ml-auto font-mono text-[10px]" style={{ color: "var(--gw-t10)" }}>
                    {note.author_display_fallback ?? "Unknown"}
                    <span style={{ margin: "0 4px" }}>·</span>
                    {timeAgo(note.created_at)}
                  </span>
                </div>
                <p className="text-[12.5px]" style={{ color: "var(--gw-t5)", lineHeight: 1.5 }}>
                  {note.body}
                </p>
              </div>
            );
          })}
        </div>
    </section>
  );
}

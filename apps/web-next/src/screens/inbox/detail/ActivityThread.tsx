/**
 * ActivityThread — Zone 3: time-sorted thread replies + version submissions.
 *
 * Spec §4b: avatars are 27×27 ROUNDED SQUARES (radius 8), never circles.
 * Row: flex, gap 13, padding-bottom 18. Version-event avatar bg .04/border .1
 * (empty); note-event avatar bg .06/border .12 with the author initial.
 * Event: name 13px/600 t2 + mono 11px t10 meta; quote = green left rule.
 * Reply composer: an auto-growing multi-line field with the current
 * user's own green rounded-square avatar — their uploaded photo when one
 * exists (PersonAvatar), their name's first letter otherwise, never a
 * hardcoded placeholder (this used to always show "Y" regardless of who
 * was signed in). Note-event avatars (EventAvatar) do the same for entries
 * the current user authored; a teammate's note still falls back to their
 * initial, since there is no lookup-by-id for anyone else's photo yet.
 * Enter submits and stays on this item; Shift+Enter inserts a newline;
 * Cmd/Ctrl+Enter submits and advances to the next open item (see
 * reply-composer-logic.ts). Now an auto-growing multi-line field, not a
 * fixed single-line one.
 *
 * SOURCE SPLIT: thread replies are notes-system notes attached to this
 * review carrying the "thread" tag — created here via the successor
 * /api/v1/notes endpoint. Notes WITHOUT the tag are Notes-page notes and
 * render in the rail NOTES section, never in the thread.
 * Ordering: chronological — oldest at the top, newest at the bottom.
 *
 * The placeholder reads "Add a note…" when the thread is empty and "Reply
 * to thread…" once it has at least one entry — "reply" presumes something
 * to reply to, which isn't true for the first post, solo or team.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reviews, type VersionRow } from "@gatewerk/web-core/api/reviews";
import { notes as notesApi, type Note as SystemNote } from "@gatewerk/web-core/api/notes";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { timeAgo } from "@gatewerk/web-core/lib/utils";
import { RulerTickHeader } from "~/components/RulerTickHeader";
import { PersonAvatar } from "~/components/PersonAvatar";
import { AutoGrowTextarea } from "~/components/AutoGrowTextarea";
import { classifyReplyKeydown } from "./reply-composer-logic";
import { isSampleReview } from "~/screens/onboarding/sample-review";

/** Tag marking a notes-system note as a thread reply (vs a Notes-page note). */
export const THREAD_TAG = "thread";

/**
 * Shared query for all notes attached to a review (thread + rail split it).
 *
 * Disabled for the onboarding sample. Its review exists only in the browser, so
 * there is nothing to fetch — and the walkthrough promises the reviewer that
 * nothing here is real and nothing will be sent, which has to hold on render and
 * not just on the buttons. Gating here rather than at the two call sites means
 * RailNotes inherits it and cannot drift out of the guarantee.
 */
export function attachedNotesQuery(projectId: string, reviewId: string) {
  return {
    queryKey: ["notes", "attached", "review", reviewId] as const,
    queryFn: () =>
      notesApi.list({
        project_id: projectId,
        limit: 50,
        attached_to_kind: "review" as const,
        attached_to_id: reviewId,
      }),
    enabled: !isSampleReview(reviewId),
    staleTime: 30_000,
  };
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface NoteEntry {
  kind: "note";
  id: string;
  timestamp: string;
  author: string;
  /** Set only when this note's author is the current signed-in reviewer —
   *  see PersonAvatar's doc comment for why (self-view only, no
   *  lookup-by-id for anyone else's photo). */
  authorId: string | null;
  content: string;
  optimistic?: boolean;
}

export interface VersionEntry {
  kind: "version";
  id: string;
  timestamp: string;
  version: number;
  feedback: string | null;
}

export type ActivityEntry = NoteEntry | VersionEntry;

// ── Merge helper ───────────────────────────────────────────────────────────

export function mergeTimeline(
  threadNotes: NoteEntry[],
  versions: VersionRow[],
  optimistic: NoteEntry[],
): ActivityEntry[] {
  const entries: ActivityEntry[] = [...threadNotes];

  // Only show version entries when there are multiple versions (resubmissions)
  if (versions.length > 1) {
    for (const v of versions) {
      entries.push({
        kind: "version",
        id: v.id,
        timestamp: v.created_at,
        version: v.version,
        feedback: v.feedback,
      });
    }
  }

  // Drop optimistic entries once the server copy has arrived
  // (otherwise the reply shows twice after the post-success refetch).
  const serverContents = new Set(threadNotes.map((n) => n.content));
  for (const o of optimistic) {
    if (!serverContents.has(o.content)) entries.push(o);
  }

  // Chronological: oldest at the top, newest at the bottom — the composer
  // sits below the thread and appends where the next entry will appear.
  entries.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return entries;
}

// ── Avatars (27×27 rounded squares, spec §4b) ──────────────────────────────

const AVATAR_BASE: React.CSSProperties = {
  width: 27,
  height: 27,
  borderRadius: 8,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

function EventAvatar({ entry }: { entry: ActivityEntry }) {
  if (entry.kind === "note") {
    return (
      <PersonAvatar
        userId={entry.authorId}
        fallback={entry.author.charAt(0).toUpperCase()}
        size={27}
        radius={8}
        background="rgba(var(--gw-line-rgb),.06)"
        border="1px solid rgba(var(--gw-line-rgb),.12)"
        color="var(--gw-t4)"
        fontSize={11}
      />
    );
  }
  return (
    <div
      style={{
        ...AVATAR_BASE,
        background: "rgba(var(--gw-line-rgb),.04)",
        border: "1px solid rgba(var(--gw-line-rgb),.1)",
      }}
    />
  );
}

// ── Entry row ──────────────────────────────────────────────────────────────

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const who =
    entry.kind === "note" ? entry.author : `Version ${entry.version} submitted`;
  const meta =
    entry.kind === "note"
      ? entry.optimistic
        ? "just now"
        : timeAgo(entry.timestamp)
      : `agent · ${timeAgo(entry.timestamp)}`;
  const quote = entry.kind === "version" ? entry.feedback : null;
  const body = entry.kind === "note" ? entry.content : null;

  return (
    <div className="relative flex" style={{ gap: 13, paddingBottom: 18 }}>
      <EventAvatar entry={entry} />
      {/* paddingTop centers the 13px header line against the 27px tile so
          every avatar sits in the same optical rhythm as the composer row. */}
      <div className="min-w-0 flex-1" style={{ paddingTop: 4 }}>
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold" style={{ color: "var(--gw-t2)" }}>
            {who}
          </span>
          <span className="font-mono text-[11px]" style={{ color: "var(--gw-t10)" }}>
            {meta}
          </span>
        </div>
        {quote && (
          <div
            className="text-[13px]"
            style={{
              marginTop: 8,
              color: "var(--gw-t5)",
              borderLeft: "2px solid rgba(33,181,113,.4)",
              paddingLeft: 14,
              lineHeight: 1.55,
            }}
          >
            {quote}
          </div>
        )}
        {body && (
          <div
            className="text-[13px]"
            style={{ marginTop: 6, color: "var(--gw-t5)", lineHeight: 1.55 }}
          >
            {body}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Reply composer (auto-growing multi-line, spec §4b) ─────────────────────

interface ReplyComposerProps {
  reviewId: string;
  projectId: string;
  onOptimisticAppend: (entry: NoteEntry) => void;
  /** True when the thread has no entries yet — this composer would post the
   *  first one, so "reply" is the wrong word for it (solo or team). */
  isEmpty: boolean;
  /** Single uppercase initial for the composer's own avatar, matching
   *  EventAvatar's `entry.author.charAt(0).toUpperCase()` convention —
   *  this used to be a hardcoded "Y" regardless of who was signed in. */
  authorInitial: string;
  /** The signed-in reviewer's id, so the composer's own avatar shows their
   *  uploaded photo (PersonAvatar) instead of always falling back to the
   *  initial — null only while auth is still bootstrapping. */
  authorId: string | null;
  /** Cmd/Ctrl+Enter fires this to advance to the next open item in the
   *  queue (see classifyReplyKeydown). Fires synchronously once the reply
   *  mutation has been queued (right after createNoteMutation.mutate is
   *  called), not after it resolves — deliberate, so advancing feels
   *  instant rather than waiting on the network. */
  onAdvance: () => void;
}

function ReplyComposer({
  reviewId,
  projectId,
  onOptimisticAppend,
  isEmpty,
  authorInitial,
  authorId,
  onAdvance,
}: ReplyComposerProps) {
  const [value, setValue] = useState("");
  const queryClient = useQueryClient();

  const createNoteMutation = useMutation({
    // Thread replies go through the successor notes API: a shared note
    // tagged "thread", attached to this review.
    mutationFn: ({ content }: { content: string }) =>
      notesApi.create({
        project_id: projectId,
        body: content,
        is_shared: true,
        tags: [THREAD_TAG],
        attachments: [{ target_kind: "review", target_id: reviewId }],
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["notes", "attached", "review", reviewId],
      });
      toast.success("Reply posted");
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Failed to post reply");
    },
  });

  function handleSubmit(advance: boolean) {
    const content = value.trim();
    if (!content) return;
    onOptimisticAppend({
      kind: "note",
      id: `opt_${Date.now()}`,
      timestamp: new Date().toISOString(),
      author: "You",
      authorId,
      content,
      optimistic: true,
    });
    setValue("");
    createNoteMutation.mutate({ content });
    if (advance) onAdvance();
  }

  // Enter submits and stays on this item (unchanged from the single-line
  // field's own prior behavior). Shift+Enter inserts a newline, now that
  // this is a real multi-line AutoGrowTextarea. Cmd/Ctrl+Enter submits AND
  // advances to the next open item — see reply-composer-logic.ts.
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const action = classifyReplyKeydown(e);
    if (action === "newline" || action === "none") return;
    e.preventDefault();
    handleSubmit(action === "submit-and-advance");
  }

  return (
    <div className="flex items-center" style={{ marginTop: 6, gap: 13 }}>
      {/* Current user's avatar — green rounded square. Borderless: a photo
          inside a colored ring read as an artificial frame around it;
          the fill alone still marks this row as "you" when no photo is set. */}
      <PersonAvatar
        userId={authorId}
        fallback={authorInitial}
        size={27}
        radius={8}
        background="rgba(33,181,113,.14)"
        border="none"
        color="var(--gw-green-d)"
        fontSize={11}
      />
      {/* Auto-growing multi-line field (was single-line; grows with Shift+Enter
          composition instead of scrolling internally) */}
      <div
        className="flex min-w-0 flex-1 items-center"
        style={{
          gap: 9,
          border: "1px solid rgba(var(--gw-line-rgb),.1)",
          borderRadius: 9,
          background: "var(--gw-inset-soft)",
          padding: "7px 10px",
        }}
      >
        <AutoGrowTextarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isEmpty ? "Add a note…" : "Reply to thread…"}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-t10"
          style={{
            color: "var(--gw-t3)",
            border: "none",
            lineHeight: 1.45,
            fontFamily: "inherit",
          }}
        />
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

interface Props {
  reviewId: string;
  projectId: string;
  onAdvanceToNext: () => void;
}

export function ActivityThread({ reviewId, projectId, onAdvanceToNext }: Props) {
  const [optimisticNotes, setOptimisticNotes] = useState<NoteEntry[]>([]);
  const { user } = useAuth();

  const notesQuery = useQuery(attachedNotesQuery(projectId, reviewId));

  const versionsQuery = useQuery<{ items: VersionRow[] }>({
    queryKey: ["reviews", reviewId, "versions"],
    queryFn: () => reviews.listVersions(reviewId),
    // Same reason as the notes query above: the onboarding sample has no server
    // side, so this would be a real request against a fixture id.
    enabled: !isSampleReview(reviewId),
    staleTime: 60_000,
  });

  // Thread = attached notes carrying the "thread" tag only.
  const threadNotes: NoteEntry[] = (notesQuery.data?.items ?? [])
    .filter((n: SystemNote) => n.tags.includes(THREAD_TAG))
    .map((n: SystemNote) => {
      const isCurrentUser = !!(n.author_id && user && n.author_id === user.id);
      return {
        kind: "note" as const,
        id: n.id,
        timestamp: n.created_at,
        author: isCurrentUser ? user!.name || "You" : (n.author_display_fallback ?? "Reviewer"),
        authorId: isCurrentUser ? user!.id : null,
        content: n.body,
      };
    });
  const versions = versionsQuery.data?.items ?? [];
  const entries = mergeTimeline(threadNotes, versions, optimisticNotes);

  function handleOptimisticAppend(entry: NoteEntry) {
    setOptimisticNotes((prev) => [entry, ...prev]);
  }

  return (
    <div>
      <RulerTickHeader label="Activity" />

      {/* Empty thread renders nothing between header and composer (prototype) */}
      <div className="flex flex-col">
        {entries.map((entry) => (
          <ActivityRow key={entry.id} entry={entry} />
        ))}
      </div>

      <ReplyComposer
        reviewId={reviewId}
        projectId={projectId}
        onOptimisticAppend={handleOptimisticAppend}
        isEmpty={entries.length === 0}
        authorInitial={(user?.name || "You").charAt(0).toUpperCase()}
        authorId={user?.id ?? null}
        onAdvance={onAdvanceToNext}
      />
    </div>
  );
}

/**
 * ActivityTimeline — what happened to this record, oldest first.
 *
 * Chronological, top to bottom: the submission opened the record, so it sits
 * at the top, and the decision that closed it sits at the bottom. This is the
 * Inbox thread's direction (screens/inbox/detail/ActivityThread) — the same
 * kind of information should not be read in two directions depending on which
 * screen you are on. The record LIST stays newest-first; that is a list of
 * records, not one record's story.
 *
 * Design: DetailHistory.dc.html.
 *
 * Two entries today: the decision, and the submission that opened it. The
 * feedback the decider left lives HERE, on the decision entry, rather than in
 * the Details rail — feedback is something a person said at a moment, so it
 * belongs on that moment, not in a table of record metadata.
 *
 * The submission entry carries no actor and no body. The design shows
 * "content-agent" and a note; neither is reproducible — Review has `decided_by`
 * and nothing that names who or what submitted it, and there is no submission
 * note field at all (manifest §Data adaptations 2). Inventing an actor from
 * `template_slug` would print a guess as a fact in an audit trail.
 *
 * Entries render from a list rather than as two hand-written blocks so the
 * connector line keeps working when a third entry arrives (chain steps, notes).
 */

import type { ReactNode } from "react";
import type { Review } from "@gatewerk/web-core/api/reviews";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { displayName, timeAgo } from "@gatewerk/web-core/lib/utils";
import { RulerTickHeader } from "~/components/RulerTickHeader";
import { PersonAvatar } from "~/components/PersonAvatar";
import { decisionRole, isUndecided, type DecisionRole } from "./history-model";

/** Chip fill/border/text per decision role. `edited` overrides these to amber. */
const ROLE_CHIP: Record<DecisionRole, { rgb: string; text: string }> = {
  affirmative: { rgb: "var(--gw-green-rgb)", text: "var(--gw-green-d)" },
  destructive: { rgb: "var(--gw-red-rgb)", text: "var(--gw-red-t)" },
  neutral: { rgb: "var(--gw-blue-rgb)", text: "var(--gw-blue-t)" },
};

const EDITED_CHIP = { rgb: "var(--gw-amber-rgb)", text: "var(--gw-amber-t)" };

interface Entry {
  key: string;
  chip: ReactNode;
  title: string;
  meta: string;
  body?: string | null;
}

/**
 * "approved with edits" reads as what a person did; "edited" reads as a
 * database value. Everything else is the decision word with its underscores
 * opened out, so `max_iterations_reached` stays legible.
 */
function decisionPhrase(decision: string | null): string {
  if (decision === "edited") return "approved with edits";
  return (decision ?? "decided").replace(/_/g, " ");
}

export function ActivityTimeline({ review }: { review: Review }) {
  const { user } = useAuth();
  const entries: Entry[] = [];

  entries.push({
    key: "submission",
    chip: (
      <div
        className="flex shrink-0 items-center justify-center"
        style={{
          width: 27,
          height: 27,
          borderRadius: 8,
          background: "rgba(var(--gw-line-rgb),.04)",
          border: "1px solid rgba(var(--gw-line-rgb),.1)",
          zIndex: 1,
        }}
      >
        <span
          aria-hidden
          style={{ width: 6, height: 6, borderRadius: 2, background: "var(--gw-t8)" }}
        />
      </div>
    ),
    title: "Submitted for review",
    meta: timeAgo(review.created_at),
  });

  // A lapsed record was never decided by anyone, so it gets no decision
  // entry — "System · decided" on a review nobody touched would be a lie.
  // Same predicate the record's rail uses, so the two cannot disagree about
  // whether a decision happened.
  if (!isUndecided(review)) {
    const role = decisionRole(review.decision);
    const chip = review.decision === "edited" ? EDITED_CHIP : ROLE_CHIP[role];
    const decidedBy = review.decided_by ?? "System";
    const name = displayName(decidedBy);
    // Self-view only, same rule ActorRow/PersonAvatar apply everywhere
    // else: a photo only ever renders for the current signed-in reviewer,
    // never guessed for a teammate from a name/email match elsewhere.
    const isCurrentUser = decidedBy.includes("@") && user?.email.toLowerCase() === decidedBy.toLowerCase();

    entries.push({
      key: "decision",
      chip: (
        <div style={{ zIndex: 1 }}>
          <PersonAvatar
            userId={isCurrentUser ? user!.id : null}
            fallback={(name.trim()[0] ?? "?").toUpperCase()}
            size={27}
            radius={8}
            background={`rgba(${chip.rgb},.14)`}
            border="none"
            color={chip.text}
            fontSize={11}
          />
        </div>
      ),
      title: name,
      meta: `${decisionPhrase(review.decision)} · ${timeAgo(review.decided_at ?? review.created_at)}`,
      body: review.feedback,
    });
  }

  return (
    <section>
      <RulerTickHeader label="Activity" marginClassName="mb-[18px]" />
      <div className="flex flex-col">
        {entries.map((entry, i) => (
          <div
            key={entry.key}
            className="relative flex"
            style={{ gap: 13, paddingBottom: i === entries.length - 1 ? 0 : 22 }}
          >
            {/* Connector runs from under the chip to the next entry. The last
                entry has nothing to connect to, so it gets none. */}
            {i < entries.length - 1 && (
              <div
                aria-hidden
                className="absolute"
                style={{
                  left: 13,
                  top: 28,
                  bottom: 0,
                  width: 1,
                  background: "rgba(var(--gw-line-rgb),.08)",
                }}
              />
            )}
            {entry.chip}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline" style={{ gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--gw-t2)" }}>
                  {entry.title}
                </span>
                <span className="font-mono" style={{ fontSize: 11, color: "var(--gw-t8)" }}>
                  {entry.meta}
                </span>
              </div>
              {entry.body && (
                <div
                  className="whitespace-pre-wrap break-words"
                  style={{ marginTop: 6, fontSize: 13, lineHeight: 1.55, color: "var(--gw-t5)" }}
                >
                  {entry.body}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

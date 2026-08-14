/**
 * PinnedAttachment — one card in NoteDetail's PINNED TO section, resolved to
 * the real record it names. No card of any kind ever prints a raw target id;
 * a pin that cannot be resolved says so in words instead.
 *
 * Split out of NoteDetail.tsx (which is otherwise over the repo's 300 line
 * file cap) rather than left inline, matching how NoteComposer.tsx already
 * factors TagInput.tsx and PinPicker.tsx out to their own files.
 *
 * A review pin fetches the review through `getReview`, the same
 * `["reviews","detail",id]` query key every review mutation in the app
 * already invalidates via its `["reviews"]` prefix, and shows its title
 * (`getReviewTitle`) plus its decision. A template pin fetches through
 * `getTemplate`, same story with the `["templates"]` prefix, and shows its
 * name. A chain run pin can't be resolved by any client today — PinPicker
 * cannot even search them, per pin-picker-model.ts's file comment — so it
 * renders only the kind label and is not clickable: there is nowhere true to
 * send that click. No card of any kind ever prints a raw target id.
 */
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { X } from "lucide-react";
import { assertNever } from "@gatewerk/shared";
import type { Note } from "@gatewerk/web-core/api/notes";
import { getReview, type Review } from "@gatewerk/web-core/api/reviews";
import { getTemplate } from "@gatewerk/web-core/api/templates";
import { getReviewTitle, timeAgo } from "@gatewerk/web-core/lib/utils";
import { kindLabel, type PinTarget } from "./pin-picker-model";

export type Attachment = Note["attachments"][number];

export function PinnedAttachment({
  attachment,
  onUnpin,
}: {
  attachment: Attachment;
  onUnpin: () => void;
}) {
  switch (attachment.target_kind) {
    case "review":
      return <ReviewPinCard attachment={attachment} onUnpin={onUnpin} />;
    case "template":
      return <TemplatePinCard attachment={attachment} onUnpin={onUnpin} />;
    case "chain_run":
      return <ChainRunPinCard onUnpin={onUnpin} />;
    default:
      return assertNever(attachment.target_kind);
  }
}

/** The decision line for a resolved review, or its live status when nobody has decided yet. */
function reviewMeta(review: Review): string {
  if (review.decision) {
    const label = (review.action_label ?? review.decision).replace(/_/g, " ");
    return `${label} ${timeAgo(review.decided_at ?? review.created_at)}`;
  }
  return review.status.replace(/_/g, " ");
}

function ReviewPinCard({ attachment, onUnpin }: { attachment: Attachment; onUnpin: () => void }) {
  const navigate = useNavigate();
  const reviewQuery = useQuery(getReview({ id: attachment.target_id }));
  const review = reviewQuery.data;

  if (reviewQuery.isLoading) {
    return <PinCardShell kind="review" title="Loading" onUnpin={onUnpin} />;
  }
  if (!review) {
    return <PinCardShell kind="review" title="No longer available" onUnpin={onUnpin} />;
  }

  return (
    <PinCardShell
      kind="review"
      title={getReviewTitle(review.payload ?? {}, review.id)}
      subtitle={reviewMeta(review)}
      // `/reviews/:id` is the real deep link (App.tsx's ReviewDetailRedirect):
      // it folds into the inbox's `?review=` selection, matching how any
      // other part of the app is expected to link to a review.
      onOpen={() => navigate(`/reviews/${review.id}`)}
      onUnpin={onUnpin}
    />
  );
}

function TemplatePinCard({ attachment, onUnpin }: { attachment: Attachment; onUnpin: () => void }) {
  const navigate = useNavigate();
  const templateQuery = useQuery(getTemplate({ id: attachment.target_id }));
  const template = templateQuery.data;

  if (templateQuery.isLoading) {
    return <PinCardShell kind="template" title="Loading" onUnpin={onUnpin} />;
  }
  if (!template) {
    return <PinCardShell kind="template" title="No longer available" onUnpin={onUnpin} />;
  }

  return (
    <PinCardShell
      kind="template"
      title={template.name}
      // Templates.tsx:38-39 reads its selection from `?id=`, so this is the
      // real navigable URL, not a guess.
      onOpen={() => navigate(`/templates?id=${template.id}`)}
      onUnpin={onUnpin}
    />
  );
}

function ChainRunPinCard({ onUnpin }: { onUnpin: () => void }) {
  return <PinCardShell kind="chain_run" title="a chain run" onUnpin={onUnpin} />;
}

function PinCardShell({
  kind,
  title,
  subtitle,
  onOpen,
  onUnpin,
}: {
  kind: PinTarget["kind"];
  title: string;
  subtitle?: string;
  onOpen?: () => void;
  onUnpin: () => void;
}) {
  return (
    <div
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (!onOpen) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex items-center"
      style={{
        gap: 10,
        padding: "9px 11px",
        borderRadius: 9,
        // Card shell background/border/radius copied from RailNotes.tsx:69-75.
        background: "rgba(var(--gw-line-rgb),.02)",
        border: "1px solid rgba(var(--gw-line-rgb),.08)",
        cursor: onOpen ? "pointer" : "default",
      }}
    >
      <div className="min-w-0 flex-1">
        <span
          className="font-mono uppercase"
          style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: ".07em", color: "var(--gw-t8)" }}
        >
          {kindLabel(kind)}
        </span>
        <div className="truncate" style={{ marginTop: 3, fontSize: 12.5, color: "var(--gw-t4)" }}>
          {title}
        </div>
        {subtitle && (
          <div className="truncate font-mono" style={{ marginTop: 2, fontSize: 10.5, color: "var(--gw-t8)" }}>
            {subtitle}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onUnpin();
        }}
        aria-label="Unpin"
        className="flex shrink-0 cursor-pointer items-center justify-center border-none bg-transparent"
        style={{ width: 22, height: 22, borderRadius: 6, color: "var(--gw-t8)", padding: 0 }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

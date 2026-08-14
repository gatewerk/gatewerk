/**
 * ReviewReady — the `valid / ready` state: title block, payload, feedback,
 * decision buttons and the two ghost links.
 *
 * Spec §4 (+ §7 preview banner). Design: Gatewerk External Review.dc.html:69-106.
 */

import { useState } from "react";
import type {
  TemplateActionConfigCanonical,
  TemplateField,
} from "@gatewerk/shared";
import { getReviewTitle } from "@gatewerk/web-core/lib/utils";
import {
  filterTokenActions,
  withRecipientSafety,
} from "@gatewerk/web-core/state/token-review/token-actions-state";
import { resolveFields } from "~/screens/inbox/detail/payload-fields";
import { AutoGrowTextarea } from "~/components/AutoGrowTextarea";
import { ReviewPayloadBox } from "./ReviewPayloadBox";
import { DecisionRow } from "./DecisionRow";
import { verboseAgo } from "./recipient-state";

interface ReviewProjection {
  id: string;
  payload: Record<string, unknown>;
  created_at: string;
}

interface TemplateProjection {
  description?: string;
  fields: TemplateField[];
  actions: TemplateActionConfigCanonical[];
}

interface Props {
  review: ReviewProjection;
  template: TemplateProjection | null;
  isPreview: boolean;
  senderHint?: string;
  feedback: string;
  onFeedback: (v: string) => void;
  feedbackError: string | null;
  armedId: string | null;
  pendingId: string | null;
  onAction: (action: TemplateActionConfigCanonical) => void;
  onDecline: () => void;
  onQuestions: () => void;
}

export function ReviewReady({
  review,
  template,
  isPreview,
  senderHint,
  feedback,
  onFeedback,
  feedbackError,
  armedId,
  pendingId,
  onAction,
  onDecline,
  onQuestions,
}: Props) {
  const [focused, setFocused] = useState(false);

  const fields = resolveFields({
    payload: review.payload,
    template: template ? { fields: template.fields } : null,
  });
  const actions = withRecipientSafety(
    filterTokenActions(template?.actions ?? []),
  );

  return (
    <div className="flex flex-col" style={{ gap: 20 }}>
      {isPreview && <PreviewBanner />}

      <div>
        <h1
          className="font-display text-t1"
          style={{
            margin: 0,
            fontSize: 21,
            fontWeight: 600,
            letterSpacing: "-.015em",
          }}
        >
          {getReviewTitle(review.payload, review.id)}
        </h1>
        {template?.description && (
          <p
            style={{
              margin: "6px 0 0",
              fontSize: 13,
              lineHeight: 1.55,
              color: "var(--gw-t5)",
            }}
          >
            {template.description}
          </p>
        )}
        <div
          className="flex items-center font-mono"
          style={{ marginTop: 9, gap: 9, fontSize: 11, color: "var(--gw-t8)" }}
        >
          <span>requested {verboseAgo(review.created_at)}</span>
          {senderHint && (
            <>
              <span style={{ color: "var(--gw-t11)" }}>/</span>
              <span>from {senderHint}</span>
            </>
          )}
        </div>
      </div>

      <ReviewPayloadBox fields={fields} />

      <div>
        <AutoGrowTextarea
          rows={3}
          value={feedback}
          onChange={(e) => onFeedback(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Add a note or reason for your decision…"
          style={{
            width: "100%",
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: focused
              ? "rgba(var(--gw-line-rgb),.28)"
              : "rgba(var(--gw-line-rgb),.12)",
            borderRadius: 12,
            background: "var(--gw-inset)",
            padding: "12px 14px",
            fontFamily: "inherit",
            fontSize: 13,
            lineHeight: 1.5,
            color: "var(--gw-t3)",
            outline: "none",
            boxSizing: "border-box",
            boxShadow: focused
              ? "0 0 0 3px rgba(var(--gw-line-rgb),.06)"
              : undefined,
            transition: "border-color .12s, box-shadow .12s",
          }}
        />
        {feedbackError && (
          <div
            style={{ fontSize: 11.5, color: "var(--gw-red-t)", marginTop: 8 }}
          >
            {feedbackError}
          </div>
        )}
      </div>

      <DecisionRow
        actions={actions}
        armedId={armedId}
        pendingId={pendingId}
        disabled={isPreview}
        onAction={onAction}
        onDecline={onDecline}
        onQuestions={onQuestions}
      />
    </div>
  );
}

/**
 * Preview banner (spec §7) — no design source; blue because this is
 * informational context, not a warning about the review itself. Load-bearing:
 * the server only rejects preview tokens on POST /action, so the client is what
 * keeps a preview from consuming the link via decline / raise-questions.
 */
function PreviewBanner() {
  return (
    <div
      className="font-mono"
      style={{
        border: "1px solid rgba(var(--gw-blue-rgb),.35)",
        background: "rgba(var(--gw-blue-rgb),.07)",
        color: "var(--gw-blue-t)",
        borderRadius: 11,
        padding: "10px 16px",
        fontSize: 12,
      }}
    >
      Preview · no decision can be submitted
    </div>
  );
}

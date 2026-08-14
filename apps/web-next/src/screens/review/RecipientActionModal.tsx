/**
 * RecipientActionModal — the glass modal behind "Decline" and "Send back with
 * questions". One shape, two copy sets.
 *
 * Spec §5. Design: Gatewerk External Review.dc.html:128-141 (markup) and
 * :231-241 (copy + submit tone). Both endpoints consume the link and revert the
 * review to pending; neither records a decision.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { AutoGrowTextarea } from "~/components/AutoGrowTextarea";

export type RecipientActionKind = "decline" | "questions";

interface Copy {
  title: string;
  desc: string;
  fieldLabel: string;
  placeholder: string;
  submitLabel: string;
  submitBg: string;
  submitInk: string;
}

const COPY: Record<RecipientActionKind, Copy> = {
  decline: {
    title: "Decline this review",
    desc: "This returns the review to the sender with a decline note. The link will be consumed.",
    fieldLabel: "Reason (optional)",
    placeholder: "A short reason the sender will see",
    submitLabel: "Decline review",
    submitBg: "var(--gw-red-t)",
    // `--gw-red-t` darkens substantially in light mode (unlike green, which
    // is identical in both themes), so a fixed dark ink reads fine on dark
    // mode's lighter red but fails contrast on light mode's deeper one.
    // `--gw-panel-a` flips polarity with the theme (dark in dark mode, light
    // in light mode) — the same trick HistoryListHeader.tsx's calendar
    // endpoint ink uses for the identical reason.
    submitInk: "var(--gw-panel-a)",
  },
  questions: {
    title: "Send back with questions",
    desc: "Use this if you need clarification before deciding. The reviewer will see your questions and can update the review.",
    fieldLabel: "Your questions",
    placeholder: "What do you need clarified before deciding?",
    submitLabel: "Send questions",
    submitBg: "var(--gw-green)",
    submitInk: "var(--gw-green-ink)",
  },
};

interface Props {
  kind: RecipientActionKind;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  pending: boolean;
  error: string | null;
}

export function RecipientActionModal({
  kind,
  value,
  onChange,
  onSubmit,
  onClose,
  pending,
  error,
}: Props) {
  const copy = COPY[kind];
  const [focused, setFocused] = useState(false);
  const [cancelHover, setCancelHover] = useState(false);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(10,10,8,.55)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 22,
        animation: "gw-fade .18s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={copy.title}
        style={{
          width: 440,
          maxWidth: "100%",
          background: "rgba(var(--gw-modal-rgb),.94)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          border: "1px solid rgba(var(--gw-line-rgb),.14)",
          borderRadius: 16,
          boxShadow: "0 30px 80px rgba(0,0,0,.6)",
          padding: "22px 24px",
        }}
      >
        <div
          className="font-display text-t1"
          style={{ fontSize: 17, fontWeight: 600 }}
        >
          {copy.title}
        </div>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.55,
            color: "var(--gw-t5)",
            marginTop: 6,
          }}
        >
          {copy.desc}
        </div>

        <div
          className="font-mono uppercase"
          style={{
            fontSize: 9.5,
            fontWeight: 600,
            letterSpacing: ".14em",
            color: "var(--gw-t8)",
            margin: "18px 0 8px",
          }}
        >
          {copy.fieldLabel}
        </div>

        <AutoGrowTextarea
          rows={4}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={copy.placeholder}
          autoFocus
          style={{
            width: "100%",
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: focused
              ? "rgba(var(--gw-line-rgb),.28)"
              : "rgba(var(--gw-line-rgb),.12)",
            borderRadius: 11,
            background: "var(--gw-inset)",
            padding: "11px 13px",
            fontFamily: "inherit",
            fontSize: 13,
            lineHeight: 1.5,
            color: "var(--gw-t3)",
            outline: "none",
            boxSizing: "border-box",
            transition: "border-color .12s",
          }}
        />

        {error && (
          <div
            style={{ fontSize: 11.5, color: "var(--gw-red-t)", marginTop: 8 }}
          >
            {error}
          </div>
        )}

        <div
          className="flex items-center justify-end"
          style={{ gap: 10, marginTop: 18 }}
        >
          <button
            type="button"
            className="gw-focus-ring"
            onClick={onClose}
            onMouseEnter={() => setCancelHover(true)}
            onMouseLeave={() => setCancelHover(false)}
            style={{
              height: 38,
              padding: "0 16px",
              borderRadius: 9,
              border: "1px solid rgba(var(--gw-line-rgb),.12)",
              background: cancelHover
                ? "rgba(var(--gw-line-rgb),.06)"
                : "transparent",
              color: cancelHover ? "var(--gw-t3)" : "var(--gw-t5)",
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="gw-focus-ring"
            onClick={onSubmit}
            disabled={pending}
            style={{
              height: 38,
              padding: "0 18px",
              borderRadius: 9,
              border: "none",
              background: copy.submitBg,
              color: copy.submitInk,
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: 600,
              cursor: pending ? "default" : "pointer",
              opacity: pending ? 0.85 : 1,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {pending && <Loader2 size={13} className="animate-spin" />}
            {copy.submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

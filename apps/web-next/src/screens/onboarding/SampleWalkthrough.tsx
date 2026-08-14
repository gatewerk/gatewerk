/**
 * The reviewer's first-decision walkthrough, from the onboarding design.
 *
 * Teaches the decision MODEL, not the features: read what the agent proposes,
 * change anything that is wrong, decide, and understand that deciding is final.
 * Three beats — welcome, sample, ready.
 *
 * Two structural decisions, both about safety:
 *
 *  1. It renders in the DETAIL pane and injects no row into the real list. The
 *     prototype draws a SAMPLE row beside real ones, but the list is wired to
 *     multi-select and bulk archive, so a fixture sitting in it would put a
 *     sentinel id inside operations that do reach the server. The lesson does
 *     not need the row; the guarantee does need the row's absence. Written
 *     exception against the prototype.
 *  2. It composes PayloadColumn directly rather than going through
 *     ReviewDetail, which would fetch the fixture id over the network and land
 *     on its own "Review not found" branch.
 *
 * What it reuses is exactly what has to match production: PayloadColumn,
 * FieldRow and useInlineEdit for the edit (same click target, same Cmd+Enter
 * commit, same Escape cancel, same revert), and ActionButton for the decision.
 * What it does NOT reuse is RailDecision — that component's entire body is the
 * mutation, and the point here is that there is no mutation. Its buttons only
 * move local state.
 *
 * Deliberately absent: the prototype's A / R / E shortcut chips on the closing
 * card. web-next has no single-letter action shortcuts and ShortcutsPane omits
 * them rather than showing dead promises; printing the keys here would make
 * this screen the one place in the app that lies about them.
 */

import { useState } from "react";
import { BookOpen, Check, X } from "lucide-react";
import { toast } from "sonner";
import { EmptyStateCore, StatusPill } from "~/components/empty-state";
import { PayloadColumn } from "~/screens/inbox/detail/PayloadColumn";
import { useEditedPayload } from "~/screens/inbox/detail/use-edited-payload";
import { ActionButton } from "~/screens/inbox/detail/rail/ActionButton";
import { buildSampleReview, SAMPLE_ORIGINAL_AMOUNT } from "./sample-review";
import { markReviewerOnboardingComplete } from "./reviewer-store";

type Phase = "welcome" | "sample" | "ready";

interface Props {
  /** The team the reviewer just joined, when we know it. */
  teamName?: string | null;
  /** Called once the walkthrough is finished or skipped. */
  onDone: () => void;
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div
        className="w-full animate-[gw-fade_.3s_ease]"
        style={{
          maxWidth: 452,
          borderRadius: 18,
          border: "1px solid rgba(var(--gw-line-rgb),.09)",
          background: "linear-gradient(180deg, var(--gw-panel-a), var(--gw-panel-b))",
          boxShadow: "0 18px 48px rgba(0,0,0,.3)",
          padding: 26,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function SampleWalkthrough({ teamName, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>("welcome");
  const [review] = useState(buildSampleReview);
  const editedPayload = useEditedPayload();

  const edited = editedPayload.has("amount");

  function finish() {
    markReviewerOnboardingComplete();
    onDone();
  }

  if (phase === "welcome") {
    return (
      <Card>
        <div className="flex flex-col" style={{ gap: 16 }}>
          <EmptyStateCore
            ring="none"
            tone="green"
            size={44}
            icon={<BookOpen size={19} strokeWidth={1.7} />}
          />
          <div className="flex flex-col" style={{ gap: 8 }}>
            <span className="font-mono text-[10.5px] font-medium uppercase tracking-[.14em] text-t8">
              {teamName ? `You've joined ${teamName}` : "You've joined the team"}
            </span>
            <h2
              className="font-display font-semibold text-t1"
              style={{ margin: 0, fontSize: 21, letterSpacing: "-.015em" }}
            >
              You're the human in the loop.
            </h2>
            <p className="text-[12.5px] text-t5" style={{ margin: 0, lineHeight: 1.6 }}>
              When an AI agent reaches an action that needs a person's judgment, it pauses and sends
              it here. You read it, adjust anything that's wrong, and decide. Let's walk through
              one, a sample, so nothing's at stake.
            </p>
          </div>
          <div className="flex items-center justify-between" style={{ marginTop: 6 }}>
            <button
              type="button"
              onClick={finish}
              className="gw-focus-ring cursor-pointer rounded-[8px] border-none bg-transparent font-mono text-[11.5px] text-t8 transition-colors hover:text-t5"
              style={{ padding: "6px 8px", marginLeft: -8 }}
            >
              Skip
            </button>
            <button
              type="button"
              onClick={() => setPhase("sample")}
              className="gw-focus-ring cursor-pointer rounded-[10px] border-none text-[13px] font-semibold"
              style={{
                background: "var(--gw-green)",
                color: "var(--gw-green-ink)",
                padding: "10px 20px",
                boxShadow: "0 6px 18px rgba(var(--gw-green-rgb),.18)",
              }}
            >
              Show me a sample
            </button>
          </div>
        </div>
      </Card>
    );
  }

  if (phase === "ready") {
    return (
      <Card>
        <div className="flex flex-col items-center text-center" style={{ gap: 16 }}>
          <EmptyStateCore
            ring="live"
            tone="green"
            size={52}
            icon={<Check size={23} strokeWidth={2} />}
          />
          <div className="flex flex-col" style={{ gap: 7 }}>
            <h2
              className="font-display font-semibold text-t1"
              style={{ margin: 0, fontSize: 19, letterSpacing: "-.015em" }}
            >
              That's the whole job
            </h2>
            <p className="text-[12.5px] text-t5" style={{ margin: 0, lineHeight: 1.6 }}>
              Read what the agent proposes, change anything that's off, then approve or reject. Your
              call is the final word, nothing runs until you say so.
            </p>
          </div>
          <StatusPill variant="live" label="Listening" />
          <button
            type="button"
            onClick={finish}
            className="gw-focus-ring cursor-pointer rounded-[10px] border-none text-[13px] font-semibold"
            style={{
              background: "var(--gw-green)",
              color: "var(--gw-green-ink)",
              padding: "10px 20px",
              marginTop: 4,
            }}
          >
            Go to my inbox
          </button>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* The banner is the honesty contract for this whole screen. It says what
          is true — nothing here is real — before the reviewer touches anything. */}
      <div
        className="flex shrink-0 items-center"
        style={{
          gap: 10,
          padding: "11px 22px",
          borderBottom: "1px solid rgba(var(--gw-blue-rgb),.18)",
          background: "rgba(var(--gw-blue-rgb),.08)",
          color: "var(--gw-blue-t)",
        }}
      >
        <BookOpen size={14} strokeWidth={1.7} />
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[.1em]">
          Sample review
        </span>
        <span className="text-[12px] text-t6">
          Practice freely, nothing here is real and nothing will be sent.
        </span>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div style={{ padding: "20px 28px 0" }}>
            <h2
              className="font-display font-semibold text-t1"
              style={{ margin: 0, fontSize: 19, letterSpacing: "-.015em" }}
            >
              Refund 180 to a test customer
            </h2>
            <div className="font-mono text-[11.5px] text-t8" style={{ marginTop: 5 }}>
              refund-approval / opened now / v1 / practice
            </div>
            {!edited && (
              // Shown until the first commit, then gone for good — a coach mark
              // that keeps nagging after you have done the thing is noise.
              <div
                className="gw-coach font-mono text-[10.5px]"
                style={{
                  marginTop: 14,
                  color: "var(--gw-blue-t)",
                  animation: "gw-coach 1900ms ease-in-out infinite",
                }}
              >
                ← click the amount to change it
              </div>
            )}
          </div>
          <PayloadColumn
            review={review}
            editedPayload={editedPayload}
            onAdvanceToNext={() => {}}
            showActivity={false}
          />
        </div>

        {/* A decision rail in shape only. RailDecision is not reused because
            RailDecision IS the mutation, and there is none here. */}
        <aside
          className="flex h-full flex-col overflow-y-auto"
          style={{
            width: 316,
            minWidth: 316,
            flexShrink: 0,
            borderLeft: "1px solid rgba(var(--gw-line-rgb),.07)",
            padding: "24px 22px",
            gap: 14,
          }}
        >
          <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[.12em] text-t8">
            Decision
          </span>
          <ActionButton
            label={edited ? "Approve with edit" : "Approve"}
            tone="green"
            onClick={() => {
              toast.success(edited ? "Sample approved with your edit" : "Sample approved");
              setPhase("ready");
            }}
          />
          <ActionButton
            label="Reject"
            tone="red"
            onClick={() => {
              toast.success("Sample rejected");
              setPhase("ready");
            }}
          />
          <p className="text-[11.5px] text-t8" style={{ margin: "6px 0 0", lineHeight: 1.5 }}>
            A decision is final. On real reviews, the agent acts the instant you approve.
          </p>
          {edited && (
            <p className="text-[11.5px] text-amber-t" style={{ margin: 0, lineHeight: 1.5 }}>
              You changed the amount from {SAMPLE_ORIGINAL_AMOUNT}. Approving sends your version,
              not the agent's.
            </p>
          )}
          <button
            type="button"
            onClick={finish}
            className="gw-focus-ring cursor-pointer rounded-[8px] border-none bg-transparent font-mono text-[11.5px] text-t8 transition-colors hover:text-t5"
            style={{ marginTop: "auto", padding: "6px 8px", alignSelf: "flex-start", marginLeft: -8 }}
          >
            <X size={11} strokeWidth={2} style={{ display: "inline", marginRight: 5 }} />
            Skip the walkthrough
          </button>
        </aside>
      </div>
    </div>
  );
}

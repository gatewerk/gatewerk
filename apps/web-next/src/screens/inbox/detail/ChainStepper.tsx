/**
 * ChainStepper — Zone 3: the relay.
 *
 * C1 (charter §3) is what this component exists for. A chain is a route of
 * approvers: one request, one payload, several named humans in order. Step 2's
 * reviewer used to see four status tiles and nothing else — they could tell
 * that someone had gone before them and not what that person concluded. The
 * junior's hour is what makes the senior's minute possible, and none of it
 * reached the person who needed it.
 *
 * So each step now says what it knows, and only what it knows:
 *   decided → who decided, what they decided, when, and their note
 *   active  → the guidance written for this reviewer, when there is any
 *   future  → the name and who it is going to, as a label
 *
 * Tile language is unchanged from the prototype (inbox chain section, lines
 * 426-437 + 2184-2191): solid 27x27 rounded-square tiles, the same tile
 * language as the activity avatars, stacked rows, no connector lines, no
 * numbers. A `rejected` tile joins done/active/todo — a stopped chain used to
 * render as though it were still waiting, which is the one thing a status tile
 * must never do.
 *
 * Renders NULL when review.chain_run_id is absent (the common case).
 * Fetches getChainContext(reviewId).
 */
import { useQuery } from "@tanstack/react-query";
import { reviews, type ChainStep, type ChainContext } from "@gatewerk/web-core/api/reviews";
import { timeAgo } from "@gatewerk/web-core/lib/utils";
import { RulerTickHeader } from "~/components/RulerTickHeader";

// ── Types ──────────────────────────────────────────────────────────────────

type StepTileStatus = "done" | "rejected" | "active" | "todo";

function assertNever(x: never): never {
  throw new Error(`Unhandled step status: ${String(x)}`);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function toTileStatus(raw: string): StepTileStatus {
  if (raw === "completed" || raw === "approved") return "done";
  // A rejected step stopped the route. Folding it into `todo` drew a dim,
  // waiting-looking tile over a chain that had already ended.
  if (raw === "rejected" || raw === "expired") return "rejected";
  if (raw === "active") return "active";
  // pending, skipped, superseded — all render as todo (muted)
  return "todo";
}

/** Mono "who" label from the step's assignee spec (`role · legal` etc.). */
function stepWho(step: ChainStep): string {
  const spec = step.assignee_spec as Record<string, unknown> | null;
  const a = spec?.assignee as Record<string, unknown> | undefined;
  if (a?.kind === "role") return `role · ${String(a.role)}`;
  if (a?.kind === "user")
    return String(a.email ?? a.user_id ?? "");
  if (a?.kind === "external_token") return "external token";
  return "";
}

/**
 * What a decided step concluded, in the plainest words available.
 *
 * The API only fills these once the step's review is terminal, so their
 * presence is the signal — there is no separate "has decided" flag to drift
 * out of sync with them.
 */
function verdictLabel(decision: string | null): string | null {
  if (!decision) return null;
  if (decision === "approved" || decision === "edited") return "approved";
  if (decision === "rejected") return "rejected";
  if (decision === "expired") return "expired without a decision";
  return decision;
}

// ── Step tile (27×27 rounded square, the design's dot style) ───────────────

const TILE_BASE: React.CSSProperties = {
  width: 27,
  height: 27,
  borderRadius: 8,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  zIndex: 1,
};

function StepTile({ status }: { status: StepTileStatus }) {
  if (status === "done") {
    return (
      <div
        style={{
          ...TILE_BASE,
          background: "rgba(33,181,113,.16)",
          border: "1px solid rgba(33,181,113,.4)",
          color: "var(--gw-green-d)",
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        ✓
      </div>
    );
  }
  if (status === "rejected") {
    return (
      <div
        style={{
          ...TILE_BASE,
          background: "rgba(var(--gw-red-rgb),.14)",
          border: "1px solid rgba(var(--gw-red-rgb),.38)",
          color: "var(--gw-red-t)",
          fontSize: 13,
          fontWeight: 700,
        }}
      >
        ×
      </div>
    );
  }
  if (status === "active") {
    return (
      <div
        style={{
          ...TILE_BASE,
          background: "rgba(var(--gw-blue-rgb),.16)",
          border: "1px solid rgba(var(--gw-blue-rgb),.5)",
          boxShadow: "0 0 0 3px rgba(var(--gw-blue-rgb),.12)",
        }}
      />
    );
  }
  if (status === "todo") {
    return (
      <div
        style={{
          ...TILE_BASE,
          background: "rgba(var(--gw-line-rgb),.04)",
          border: "1px solid rgba(var(--gw-line-rgb),.1)",
        }}
      />
    );
  }
  return assertNever(status);
}

// ── Main component ─────────────────────────────────────────────────────────

interface Props {
  reviewId: string;
  /** The chain's name comes from context; also used in the section header. */
  chainRunId: string;
}

function ChainStepperInner({ reviewId }: { reviewId: string }) {
  const { data, isLoading } = useQuery<ChainContext>({
    queryKey: ["review-chain", reviewId],
    queryFn: () => reviews.getChainContext(reviewId),
    staleTime: 30_000,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-6 rounded-[6px]"
            style={{ background: "rgba(var(--gw-line-rgb),.06)", width: i === 1 ? "60%" : "80%" }}
          />
        ))}
      </div>
    );
  }

  if (!data || !data.steps || data.steps.length === 0) return null;

  return (
    <>
      <RulerTickHeader label={data.name ? `Chain · ${data.name}` : "Chain"} />
      <div className="flex flex-col">
        {data.steps.map((step) => {
          const tileStatus = toTileStatus(step.status);
          const who = stepWho(step);
          const verdict = verdictLabel(step.decision);
          // Guidance belongs to the person doing the step, so it is shown while
          // the step is open. Once decided, what they concluded matters more
          // than what they were asked to weigh.
          const showGuidance = tileStatus === "active" && !!step.guidance;

          return (
            <div
              key={step.id}
              className="relative flex"
              style={{ gap: 13, paddingBottom: 16 }}
            >
              <StepTile status={tileStatus} />
              <div className="min-w-0 flex-1" style={{ paddingTop: 3 }}>
                <div className="flex items-baseline gap-2">
                  <span
                    className="text-[13px] font-semibold"
                    style={{
                      color: tileStatus === "todo" ? "var(--gw-t7)" : "var(--gw-t2)",
                    }}
                  >
                    {step.name ?? `Step ${step.step_number}`}
                  </span>
                  {who && (
                    <span
                      className="font-mono text-[11px]"
                      style={{ color: "var(--gw-t10)" }}
                    >
                      {who}
                    </span>
                  )}
                </div>

                {/* The relay itself. A prior decision, stated by the person who
                    made it, so the reviewer reading this can say what happened
                    before them without leaving their own review. */}
                {verdict && (
                  <div className="mt-[3px] text-[12px]" style={{ color: "var(--gw-t5)" }}>
                    {step.decided_by ? `${step.decided_by} ` : ""}
                    {verdict}
                    {step.decided_at ? ` · ${timeAgo(step.decided_at)}` : ""}
                  </div>
                )}
                {verdict && step.feedback && (
                  <div
                    className="mt-[5px] rounded-[8px] px-2.5 py-1.5 text-[12px] leading-relaxed"
                    style={{
                      color: "var(--gw-t4)",
                      background: "rgba(var(--gw-line-rgb),.05)",
                      border: "1px solid rgba(var(--gw-line-rgb),.08)",
                    }}
                  >
                    {step.feedback}
                  </div>
                )}

                {showGuidance && (
                  <div className="mt-[3px] text-[12px] leading-relaxed" style={{ color: "var(--gw-t5)" }}>
                    {step.guidance}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * ChainStepper — renders null when review has no chain_run_id.
 */
export function ChainStepper({
  reviewId,
  chainRunId,
}: Props) {
  if (!chainRunId) return null;
  return <ChainStepperInner reviewId={reviewId} />;
}

export { toTileStatus, verdictLabel, stepWho };

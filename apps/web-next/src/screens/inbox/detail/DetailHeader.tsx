/**
 * DetailHeader — Zone 2: title, share/overflow, meta strip.
 *
 * NO status stamp here (spec §3): the urgent/waiting signal lives in the
 * list-row stamp and the DETAILS rail, never the detail header.
 * No decision buttons here (those are Zone 4 / 3c).
 *
 * The overflow menu carries only what works. It used to render Claim/Release,
 * Reassign and Snooze permanently disabled beside a single live Copy id — an
 * affordance for a behaviour the reader cannot have, which the app's own rule
 * forbids. Claim/Release and Reassign are soft-locks against a colleague and
 * mean nothing to a solo operator, so they wait for Team (the API has carried
 * them since reviews/hold.ts; nothing was deleted). Snooze is not a team
 * feature — "not now, resurface later" matters more alone, not less — so it
 * is wired here against the endpoint that was already built.
 */
import { useState } from "react";
import { Share2, MoreHorizontal, Check, Clock, Copy } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reviews as reviewsApi } from "@gatewerk/web-core/api/reviews";
import type { Review } from "@gatewerk/web-core/api/reviews";
import { getReviewTitle, timeAgo } from "@gatewerk/web-core/lib/utils";
import { ShareModal } from "./ShareModal";

interface Props {
  review: Review;
}

export function DetailHeader({ review }: Props) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const title = getReviewTitle(review.payload ?? {}, review.id);
  const version = review.current_version ?? 1;
  // Meta strip shows the mono SLUG (`proposal-review / opened 1mo ago / v2`),
  // not the display name, and no oversight segment (spec §3 + prototype).
  const templateSlug = review.template_slug ?? review.template?.name ?? "unknown";

  const queryClient = useQueryClient();

  const snoozeMutation = useMutation({
    mutationFn: () =>
      reviewsApi.snooze(review.id, {
        until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["review", review.id] });
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      toast.success("Snoozed for an hour");
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Could not snooze this review");
    },
  });

  function copyId() {
    navigator.clipboard.writeText(review.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
    setOverflowOpen(false);
  }

  return (
    <div
      style={{
        padding: "20px 28px 15px",
        borderBottom: "1px solid rgba(var(--gw-line-rgb),.07)",
      }}
    >
      {/* Title row — title only, no status stamp (spec §3); single flat
          row, gap 13px between title, share, and overflow (prototype) */}
      <div className="flex items-center" style={{ gap: 13 }}>
        <h1
          className="min-w-0 flex-1 truncate font-display text-[23px] font-semibold leading-tight"
          style={{ letterSpacing: "-.015em", color: "var(--gw-t1)" }}
        >
          {title}
        </h1>
        <button
          type="button"
          title="Share"
          onClick={() => setShareOpen(true)}
          className="flex h-[32px] w-[32px] shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-none bg-transparent text-t6 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.07)] hover:text-t3"
        >
          <Share2 size={16} strokeWidth={1.8} />
        </button>
        <div className="relative shrink-0">
          <button
            type="button"
            title="More options"
            className="flex h-[32px] w-[32px] cursor-pointer items-center justify-center rounded-[8px] border-none bg-transparent text-t6 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.07)] hover:text-t3"
            onClick={() => setOverflowOpen((o) => !o)}
          >
            {/* Three filled dots, r=1.7 (prototype overflow glyph) */}
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="19" cy="12" r="1.7" />
            </svg>
          </button>
            {overflowOpen && (
              <>
                <div className="fixed inset-0 z-[39]" onClick={() => setOverflowOpen(false)} />
                <div
                  className="absolute right-0 z-[40] flex flex-col rounded-[11px]"
                  style={{
                    top: 38,
                    width: 198,
                    gap: 1,
                    padding: 6,
                    background: "rgba(var(--gw-glass-rgb),.74)",
                    backdropFilter: "blur(20px) saturate(140%)",
                    WebkitBackdropFilter: "blur(20px) saturate(140%)",
                    border: "1px solid rgba(var(--gw-line-rgb),.14)",
                    boxShadow: "0 18px 44px rgba(0,0,0,.5), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
                  }}
                >
                  <button
                    type="button"
                    disabled={snoozeMutation.isPending}
                    className="flex w-full cursor-pointer items-center rounded-[7px] border-none text-left text-[13px] transition-colors disabled:cursor-wait disabled:opacity-50"
                    style={{ gap: 10, padding: "8px 10px", background: "transparent", color: "var(--gw-t5)" }}
                    onClick={() => {
                      setOverflowOpen(false);
                      snoozeMutation.mutate();
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(var(--gw-line-rgb),.08)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <Clock size={12} />
                    Snooze 1h
                  </button>
                  <div style={{ height: 1, background: "rgba(var(--gw-line-rgb),.08)", margin: "4px 0" }} />
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center rounded-[7px] border-none text-left text-[13px] transition-colors"
                    style={{ gap: 10, padding: "8px 10px", background: "transparent", color: "var(--gw-t5)" }}
                    onClick={copyId}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(var(--gw-line-rgb),.08)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    {copied ? (
                      <Check size={12} style={{ color: "var(--gw-green-t)" }} />
                    ) : (
                      <Copy size={12} />
                    )}
                    {copied ? "Copied" : "Copy review id"}
                  </button>
                </div>
              </>
            )}
        </div>
      </div>

      {/* Meta strip — the app's other breadcrumb lines (Templates'
          DetailHeader.tsx, the /r review page) all separate parts with a
          dedicated "/" span dimmer than the text around it; this one
          dropped that in favor of space-only, which read as a third,
          inconsistent grammar once the two screens sat side by side.
          Match Templates. */}
      <div
        className="flex items-center gap-[9px] font-mono text-[11.5px]"
        style={{ marginTop: 9, color: "var(--gw-t8)" }}
      >
        <span>{templateSlug}</span>
        <span style={{ color: "var(--gw-t11)" }}>/</span>
        <span>opened {timeAgo(review.created_at)}</span>
        <span style={{ color: "var(--gw-t11)" }}>/</span>
        <span>v{version}</span>
      </div>

      {/* Glass share modal (prototype lines 891-1001) */}
      {shareOpen && <ShareModal review={review} onClose={() => setShareOpen(false)} />}
    </div>
  );
}

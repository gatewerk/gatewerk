/**
 * RailReviewLink — Zone 4 §2: the REVIEW LINK card (spec §5d, prototype
 * lines 483-500). Only rendered when review.active_token exists.
 *
 * Card: border rgba(line,.1), radius 10, bg --gw-inset-soft, padding 12.
 *  - Token row: 6px glowing green dot + mono 11.5 t4 link (ellipsis) +
 *    24×24 copy button (t8, hover bg .07 + t3).
 *  - "shared with {recipient}" mono 10.5 (t8 label / t5 value).
 *  - Chips: auth level + expiry — mono 10px t6, bg rgba(line,.05), r5, 2px 7px.
 *  - Actions row (top hairline): Manage · Preview (12px/500 blue-t) + Revoke
 *    (red-t, right-aligned). Manage opens the share modal in manage mode;
 *    Preview opens a real is_preview token in a new tab.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reviews } from "@gatewerk/web-core/api/reviews";
import type { Review } from "@gatewerk/web-core/api/reviews";
import {
  clearCachedTokenLink,
  readCachedTokenLink,
} from "@gatewerk/web-core/lib/token-link-cache";
import { RulerTickHeader } from "~/components/RulerTickHeader";
import { ShareModal } from "../ShareModal";
import {
  absoluteTokenUrl,
  copyToClipboard,
  expiresLabel,
} from "../share-link-utils";

interface Props {
  review: Review;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-mono text-[10px]"
      style={{
        color: "var(--gw-t6)",
        background: "rgba(var(--gw-line-rgb),.05)",
        borderRadius: 5,
        padding: "2px 7px",
      }}
    >
      {children}
    </span>
  );
}

function TextAction({
  label,
  color,
  hoverColor,
  onClick,
}: {
  label: string;
  color: string;
  hoverColor?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer border-none bg-transparent p-0 text-[12px] font-medium transition-all"
      style={{ color, fontFamily: "inherit" }}
      onMouseEnter={(e) => {
        if (hoverColor) e.currentTarget.style.color = hoverColor;
        else e.currentTarget.style.opacity = ".8";
      }}
      onMouseLeave={(e) => {
        if (hoverColor) e.currentTarget.style.color = color;
        else e.currentTarget.style.opacity = "1";
      }}
    >
      {label}
    </button>
  );
}

export function RailReviewLink({ review }: Props) {
  const token = review.active_token;
  const [shareOpen, setShareOpen] = useState(false);
  const queryClient = useQueryClient();

  const revokeMutation = useMutation({
    mutationFn: () => reviews.revokeReviewToken(review.id),
    onSuccess: () => {
      clearCachedTokenLink(review.id);
      queryClient.invalidateQueries({ queryKey: ["review", review.id] });
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      toast.success("Review link revoked");
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Revoke failed");
    },
  });

  // Synchronous window.open in the click handler (popup blockers kill opens
  // from async callbacks); navigated once the preview token exists.
  const previewMutation = useMutation({
    mutationFn: ({ win }: { win: Window | null }) =>
      reviews
        .createReviewToken(review.id, {
          recipient_label: "Preview",
          auth_level: "public",
          expiryHours: 24,
          preview: true,
        })
        .then((res) => ({ res, win })),
    onSuccess: ({ res, win }) => {
      const url = absoluteTokenUrl(res.url);
      if (win) win.location.href = url;
      else window.open(url, "_blank", "noopener,noreferrer");
    },
    onError: (e: unknown, vars) => {
      vars.win?.close();
      toast.error(e instanceof Error ? e.message : "Failed to generate preview");
    },
  });

  function openPreview() {
    const win = window.open("about:blank", "_blank");
    previewMutation.mutate({ win });
  }

  if (!token) return null;

  const cachedUrl = readCachedTokenLink(review.id);
  const linkLabel = cachedUrl
    ? absoluteTokenUrl(cachedUrl)
    : (token.id ?? token.recipient_label);

  function copyLink() {
    if (cachedUrl) {
      copyToClipboard(absoluteTokenUrl(cachedUrl), (ok) => {
        if (ok) toast.success("Link copied to clipboard");
        else toast.error("Could not access the clipboard");
      });
    } else {
      toast.error("Link unavailable. Revoke and generate a new one to copy it.");
    }
  }

  return (
    <section>
      <RulerTickHeader label="Review link" marginClassName="mb-[13px] mt-0" endTick={false} />

      {/* Card (spec §5d) */}
      <div
        style={{
          border: "1px solid rgba(var(--gw-line-rgb),.1)",
          borderRadius: 10,
          background: "var(--gw-inset-soft)",
          padding: 12,
        }}
      >
        {/* Token row */}
        <div className="flex items-center" style={{ gap: 9 }}>
          <span
            className="shrink-0"
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--gw-green-d)",
              boxShadow: "0 0 7px 1px rgba(63,202,138,.5)",
            }}
          />
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11.5px]"
            style={{ color: "var(--gw-t4)" }}
          >
            {linkLabel}
          </span>
          <button
            type="button"
            title="Copy link"
            onClick={copyLink}
            className="flex shrink-0 cursor-pointer items-center justify-center border-none bg-transparent transition-colors"
            style={{ width: 24, height: 24, borderRadius: 6, color: "var(--gw-t8)" }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(var(--gw-line-rgb),.07)";
              e.currentTarget.style.color = "var(--gw-t3)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--gw-t8)";
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
          </button>
        </div>

        {/* Shared with */}
        <div
          className="flex items-center font-mono text-[10.5px]"
          style={{ marginTop: 10, gap: 8, color: "var(--gw-t8)" }}
        >
          <span>shared with</span>
          <span style={{ color: "var(--gw-t5)" }}>{token.recipient_label}</span>
        </div>

        {/* Chips */}
        <div className="flex flex-wrap" style={{ marginTop: 9, gap: 6 }}>
          <Chip>{token.auth_level}</Chip>
          {token.expires_at && <Chip>{expiresLabel(token.expires_at)}</Chip>}
        </div>

        {/* Actions */}
        <div
          className="flex items-center"
          style={{
            marginTop: 11,
            paddingTop: 11,
            borderTop: "1px solid rgba(var(--gw-line-rgb),.07)",
            gap: 14,
          }}
        >
          <TextAction
            label="Manage"
            color="var(--gw-blue-t)"
            hoverColor="var(--gw-blue-h)"
            onClick={() => setShareOpen(true)}
          />
          <TextAction
            label="Preview"
            color="var(--gw-blue-t)"
            hoverColor="var(--gw-blue-h)"
            onClick={openPreview}
          />
          <span className="flex-1" />
          <TextAction
            label={revokeMutation.isPending ? "Revoking…" : "Revoke"}
            color="var(--gw-red-t)"
            onClick={() => revokeMutation.mutate()}
          />
        </div>
      </div>

      {/* Manage opens the glass share modal in manage mode */}
      {shareOpen && <ShareModal review={review} onClose={() => setShareOpen(false)} />}
    </section>
  );
}

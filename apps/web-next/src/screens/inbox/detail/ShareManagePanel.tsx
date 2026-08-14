/**
 * ShareManagePanel — the manage-mode body of the glass share modal
 * (extracted from ShareModal for the max-lines budget; markup unchanged).
 */
import type { Review } from "@gatewerk/web-core/api/reviews";
import { timeAgo } from "@gatewerk/web-core/lib/utils";
import { absoluteTokenUrl, expiresLabel } from "./share-link-utils";
import { SegmentedChip } from "./share-modal-parts";

interface Props {
  review: Review;
  activeToken: Review["active_token"];
  createdUrl: string | null;
  onCopy: () => void;
  onExtend: (hours: number) => void;
  onRevoke: () => void;
  revokePending: boolean;
  onClose: () => void;
}

export function ShareManagePanel({
  review,
  activeToken,
  createdUrl,
  onCopy,
  onExtend,
  onRevoke,
  revokePending,
  onClose,
}: Props) {
  return (
    <>
      {/* Live link card */}
      <div
        style={{
          marginTop: 22,
          border: "1px solid rgba(var(--gw-line-rgb),.1)",
          borderRadius: 12,
          background: "var(--gw-inset)",
          padding: "15px 16px",
        }}
      >
        <div className="flex items-center" style={{ gap: 10 }}>
          <span
            className="shrink-0"
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--gw-green-d)",
              boxShadow: "0 0 8px 1px rgba(63,202,138,.5)",
            }}
          />
          <span
            className="min-w-0 flex-1 truncate font-mono text-[13px]"
            style={{ color: "var(--gw-t3)" }}
          >
            {createdUrl
              ? absoluteTokenUrl(createdUrl)
              : (activeToken?.recipient_label ?? "gw_tok_…")}
          </span>
          <button
            type="button"
            onClick={onCopy}
            className="flex shrink-0 cursor-pointer items-center gap-[6px] border-none transition-colors"
            style={{
              padding: "6px 11px",
              borderRadius: 8,
              border: "1px solid rgba(var(--gw-line-rgb),.14)",
              background: "transparent",
              color: "var(--gw-t4)",
              fontSize: 12,
              fontWeight: 500,
              fontFamily: "inherit",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(var(--gw-line-rgb),.06)";
              e.currentTarget.style.color = "var(--gw-t2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--gw-t4)";
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
            Copy
          </button>
        </div>
      </div>

      {/* Info rows */}
      <div className="flex flex-col" style={{ marginTop: 18, gap: 13 }}>
        {[
          ["Shared with", activeToken?.recipient_label ?? "External reviewer", "var(--gw-t4)"],
          ["Authentication", activeToken?.auth_level ?? "public", "var(--gw-t4)"],
          // The LINK's creation date, not the review's — a link minted today on
          // an older review otherwise reads as created days ago.
          ["Created", activeToken?.created_at ? activeToken.created_at.slice(0, 10) : "", "var(--gw-t4)"],
          [
            "Expires",
            activeToken?.expires_at ? expiresLabel(activeToken.expires_at) : "",
            "var(--gw-amber-t)",
          ],
          [
            "Opened by recipient",
            activeToken?.opened_at ? timeAgo(activeToken.opened_at) : "Not yet",
            "var(--gw-t4)",
          ],
        ].map(([label, value, color]) => (
          <div key={label} className="flex items-center justify-between">
            <span className="text-[13px]" style={{ color: "var(--gw-t8)" }}>
              {label}
            </span>
            <span className="font-mono text-[12.5px]" style={{ color }}>
              {value}
            </span>
          </div>
        ))}
      </div>

      {/* Extend expiry */}
      <div style={{ marginTop: 20 }}>
        <div
          className="text-[14px] font-semibold"
          style={{ color: "var(--gw-t3)", marginBottom: 11 }}
        >
          Extend expiry
        </div>
        <div
          className="inline-flex items-center"
          style={{
            gap: 2,
            background: "var(--gw-inset)",
            border: "1px solid rgba(var(--gw-line-rgb),.09)",
            borderRadius: 10,
            padding: 3,
          }}
        >
          {(
            [
              ["+24h", 24],
              ["+7d", 168],
              ["+30d", 720],
            ] as const
          ).map(([label, hours]) => (
            <SegmentedChip
              key={label}
              label={label}
              active={false}
              onClick={() => onExtend(hours)}
            />
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center" style={{ marginTop: 24, gap: 14 }}>
        <button
          type="button"
          onClick={onRevoke}
          disabled={revokePending}
          className="cursor-pointer border-none bg-transparent transition-opacity hover:opacity-80"
          style={{
            fontSize: 13.5,
            fontWeight: 500,
            color: "var(--gw-red-t)",
            fontFamily: "inherit",
            padding: 0,
          }}
        >
          {revokePending ? "Revoking…" : "Revoke link"}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer border-none bg-transparent transition-colors"
          style={{
            fontSize: 13.5,
            fontWeight: 500,
            color: "var(--gw-t6)",
            padding: "0 6px",
            fontFamily: "inherit",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gw-t3)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--gw-t6)")}
        >
          Done
        </button>
      </div>
    </>
  );
}

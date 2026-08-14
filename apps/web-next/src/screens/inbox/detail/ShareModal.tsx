/**
 * ShareModal — glass share-review-via-link modal (prototype lines 891-1001).
 *
 * Two modes:
 *  - create: recipient + note + auth options (public / email_otp / account)
 *    + expiry segmented control → reviews.createReviewToken.
 *  - manage: live-link card (glowing dot + Copy) + info rows + extend expiry
 *    + Revoke (reviews.revokeReviewToken).
 *
 * Surface: 520px, rgba(var(--gw-modal-rgb),.9), blur(28px) saturate(150%),
 * radius 18, shadow 0 40px 90px rgba(0,0,0,.62) + inset top line.
 * Backdrop rgba(10,10,8,.55) + blur(5px). Escape and backdrop-click close.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reviews } from "@gatewerk/web-core/api/reviews";
import type { Review } from "@gatewerk/web-core/api/reviews";
import { templates } from "@gatewerk/web-core/api/templates";
import { seedShareAuthLevel, SHARE_AUTH_FALLBACK } from "@gatewerk/web-core/state/inbox/share-auth-default";
import {
  cacheTokenLink,
  clearCachedTokenLink,
  readCachedTokenLink,
} from "@gatewerk/web-core/lib/token-link-cache";
import { absoluteTokenUrl, copyToClipboard } from "./share-link-utils";
import { AutoGrowTextarea } from "~/components/AutoGrowTextarea";
import {
  AUTH_OPTIONS,
  CONTEXT_PANEL,
  EXPIRY_HOURS,
  EXPIRY_OPTIONS,
  FOCUS_RING,
  INPUT_STYLE,
  SegmentedChip,
  type AuthKey,
  type ExpiryKey,
} from "./share-modal-parts";
import { ShareManagePanel } from "./ShareManagePanel";

interface Props {
  review: Review;
  onClose: () => void;
}

export function ShareModal({ review, onClose }: Props) {
  const activeToken = review.active_token;
  const [mode, setMode] = useState<"create" | "manage">(
    activeToken ? "manage" : "create",
  );
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  // Defaults to the tier that can name who decided. See AUTH_OPTIONS. A
  // template may raise this but never lower it — seedShareAuthLevel.
  const [auth, setAuth] = useState<AuthKey>(SHARE_AUTH_FALLBACK);
  const [authEmail, setAuthEmail] = useState("");
  const [authUserId, setAuthUserId] = useState("");
  const [expiry, setExpiry] = useState<ExpiryKey>("24h");
  const [customHours, setCustomHours] = useState("48");
  // The raw URL is only returned once at creation; hold it for Copy and
  // fall back to the localStorage cache (same as the old app) on reopen.
  const [createdUrl, setCreatedUrl] = useState<string | null>(
    () => readCachedTokenLink(review.id),
  );
  const queryClient = useQueryClient();

  // Fetched, not read out of the templates list cache the way apps/web does
  // it. This modal opens from the Inbox, and an operator who went straight
  // there has an empty templates cache — apps/web's version silently falls
  // through to its own default in that case, which is exactly the path where
  // a deliberate `account` template would be ignored. React Query dedupes
  // this and holds it, so reopening the modal costs nothing.
  const { data: shareTemplate } = useQuery({
    queryKey: ["templates", "detail", review.template_id],
    queryFn: () => templates.get(review.template_id as string),
    enabled: mode === "create" && Boolean(review.template_id),
    staleTime: 60_000,
  });

  // Seed once, and never over an operator who has already chosen. The fetch
  // can land after the modal is on screen: moving the tier under someone who
  // has just clicked it is how a link gets minted at a tier nobody picked.
  const authSettledRef = useRef(false);
  useEffect(() => {
    if (authSettledRef.current || !shareTemplate) return;
    authSettledRef.current = true;
    setAuth(seedShareAuthLevel(shareTemplate.default_auth_level));
  }, [shareTemplate]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const createMutation = useMutation({
    mutationFn: () =>
      reviews.createReviewToken(review.id, {
        recipient_label: recipient.trim() || "External reviewer",
        note: note.trim() || undefined,
        auth_level: auth,
        auth_email: auth === "email_otp" ? authEmail.trim() || undefined : undefined,
        auth_user_id: auth === "account" ? authUserId.trim() || undefined : undefined,
        expiryHours:
          expiry === "custom"
            ? Math.max(1, parseInt(customHours, 10) || 48)
            : EXPIRY_HOURS[expiry],
      }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["review", review.id] });
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      setCreatedUrl(res.url);
      cacheTokenLink(review.id, res.url);
      setMode("manage");
      const who = recipient.trim();
      toast.success(who ? `Review link generated for ${who}` : "Review link generated");
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Could not generate link");
    },
  });

  // Preview: a real is_preview token (renders for the recipient, cannot act).
  // The tab is opened SYNCHRONOUSLY in the click handler (popup blockers kill
  // window.open from async mutation callbacks) and navigated on success.
  const previewMutation = useMutation({
    mutationFn: ({ win }: { win: Window | null }) =>
      reviews
        .createReviewToken(review.id, {
          recipient_label: recipient.trim() || "Preview",
          note: note.trim() || undefined,
          auth_level: "public",
          expiryHours:
            expiry === "custom"
              ? Math.max(1, parseInt(customHours, 10) || 48)
              : EXPIRY_HOURS[expiry],
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
    // Synchronous open inside the user gesture; navigated after the API call.
    const win = window.open("about:blank", "_blank");
    previewMutation.mutate({ win });
  }

  // Extend expiry: +24h / +7d / +30d chips (manage mode) — real endpoint.
  const extendMutation = useMutation({
    mutationFn: ({ hours }: { hours: number }) =>
      reviews.extendReviewToken(review.id, { hours }),
    onSuccess: (_res, vars) => {
      queryClient.invalidateQueries({ queryKey: ["review", review.id] });
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      const label = vars.hours === 24 ? "24h" : vars.hours === 168 ? "7d" : "30d";
      toast.success(`Expiry extended by ${label}`);
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Could not extend expiry");
    },
  });

  const revokeMutation = useMutation({
    mutationFn: () => reviews.revokeReviewToken(review.id),
    onSuccess: () => {
      clearCachedTokenLink(review.id);
      queryClient.invalidateQueries({ queryKey: ["review", review.id] });
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      toast.success("Review link revoked");
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Revoke failed");
    },
  });

  function copyLink() {
    if (createdUrl) {
      copyToClipboard(absoluteTokenUrl(createdUrl), (ok) => {
        if (ok) toast.success("Link copied to clipboard");
        else toast.error("Could not access the clipboard");
      });
    } else {
      toast.error("Link unavailable. Revoke and generate a new one to copy it.");
    }
  }

  const isManage = mode === "manage";

  // email_otp and account each pin a contextual field that the API requires
  // (ReviewTokenBodySchema superRefine in routes/reviews/tokens.ts). Before
  // email_otp became the default this was reachable only by choosing a tier
  // and then ignoring its field; now it is the first thing on screen, so the
  // absence has to read as "not ready yet" rather than as a server error.
  const missingAuthField =
    (auth === "email_otp" && !authEmail.trim()) ||
    (auth === "account" && !authUserId.trim());
  const canGenerate = !createMutation.isPending && !missingAuthField;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[80] flex items-center justify-center"
      style={{
        background: "rgba(10,10,8,.55)",
        backdropFilter: "blur(5px)",
        WebkitBackdropFilter: "blur(5px)",
        animation: "gw-fade .18s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxHeight: "88%",
          overflowY: "auto",
          background: "rgba(var(--gw-modal-rgb),.9)",
          backdropFilter: "blur(28px) saturate(150%)",
          WebkitBackdropFilter: "blur(28px) saturate(150%)",
          border: "1px solid rgba(var(--gw-line-rgb),.14)",
          borderRadius: 18,
          boxShadow:
            "0 40px 90px rgba(0,0,0,.62), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
          padding: "26px 28px 24px",
        }}
      >
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div
              className="font-display text-[20px] font-semibold"
              style={{ letterSpacing: "-.015em", color: "var(--gw-t1)" }}
            >
              {isManage ? "Manage review link" : "Share review via link"}
            </div>
            <div className="text-[13.5px]" style={{ color: "var(--gw-t5)", marginTop: 4 }}>
              {isManage
                ? "This link is live. Copy, preview, extend, or revoke it."
                : "Generate a link the recipient can open to decide."}
            </div>
          </div>
          <button
            type="button"
            onClick={openPreview}
            disabled={previewMutation.isPending}
            className="flex shrink-0 cursor-pointer items-center gap-[7px] border-none transition-colors"
            style={{
              padding: "7px 13px",
              borderRadius: 9,
              border: "1px solid rgba(var(--gw-line-rgb),.14)",
              background: "transparent",
              color: "var(--gw-t4)",
              fontSize: 12.5,
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            Preview
          </button>
        </div>

        {!isManage && (
          <>
            {/* Recipient */}
            <div className="flex flex-col" style={{ marginTop: 22, gap: 9 }}>
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="Recipient"
                style={INPUT_STYLE}
                {...FOCUS_RING}
              />
              <div className="text-[12px]" style={{ color: "var(--gw-t8)", paddingLeft: 2 }}>
                Name or email shown in the audit trail.
              </div>
            </div>

            {/* Note */}
            <div style={{ marginTop: 12 }}>
              <AutoGrowTextarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Note (optional)"
                rows={2}
                style={{
                  ...INPUT_STYLE,
                  minHeight: 64,
                  color: "var(--gw-t3)",
                  lineHeight: 1.5,
                }}
                {...FOCUS_RING}
              />
            </div>

            {/* Authentication */}
            <div style={{ marginTop: 22 }}>
              <div
                className="text-[14px] font-semibold"
                style={{ color: "var(--gw-t3)", marginBottom: 11 }}
              >
                Authentication
              </div>
              <div className="flex flex-col" style={{ gap: 9 }}>
                {AUTH_OPTIONS.map((opt) => {
                  const on = auth === opt.key;
                  return (
                    <Fragment key={opt.key}>
                      <div
                        onClick={() => {
                          // Claims the tier against a late-arriving template
                          // fetch. Whoever chose last has to be the operator.
                          authSettledRef.current = true;
                          setAuth(opt.key);
                        }}
                        className="flex cursor-pointer items-center"
                        style={{
                          gap: 14,
                          padding: "15px 17px",
                          borderRadius: 12,
                          border: on
                            ? "1px solid rgba(var(--gw-line-rgb),.24)"
                            : "1px solid rgba(var(--gw-line-rgb),.09)",
                          background: on
                            ? "rgba(var(--gw-line-rgb),.05)"
                            : "var(--gw-inset-soft)",
                        }}
                      >
                        <div className="flex-1">
                          <div className="text-[14px] font-semibold" style={{ color: "var(--gw-t2)" }}>
                            {opt.title}
                          </div>
                          <div className="text-[12.5px]" style={{ color: "var(--gw-t6)", marginTop: 3 }}>
                            {opt.desc}
                          </div>
                        </div>
                        <span
                          className="flex shrink-0 items-center justify-center"
                          style={{
                            width: 19,
                            height: 19,
                            borderRadius: "50%",
                            border: on
                              ? "1.5px solid var(--gw-green)"
                              : "1.5px solid rgba(var(--gw-line-rgb),.24)",
                          }}
                        >
                          {on && (
                            <span
                              style={{
                                width: 9,
                                height: 9,
                                borderRadius: "50%",
                                background: "var(--gw-green)",
                              }}
                            />
                          )}
                        </span>
                      </div>

                      {on && opt.key === "email_otp" && (
                        <div style={CONTEXT_PANEL}>
                          <input
                            value={authEmail}
                            onChange={(e) => setAuthEmail(e.target.value)}
                            placeholder="Recipient email"
                            style={INPUT_STYLE}
                            {...FOCUS_RING}
                          />
                          <div
                            className="text-[12px]"
                            style={{ color: "var(--gw-t8)", marginTop: 8, paddingLeft: 2 }}
                          >
                            The recipient receives a 6 digit code at this address.
                          </div>
                        </div>
                      )}

                      {on && opt.key === "account" && (
                        <div style={CONTEXT_PANEL}>
                          <input
                            value={authUserId}
                            onChange={(e) => setAuthUserId(e.target.value)}
                            placeholder="Recipient user id"
                            style={INPUT_STYLE}
                            {...FOCUS_RING}
                          />
                          <div
                            className="text-[12px]"
                            style={{ color: "var(--gw-t8)", marginTop: 8, paddingLeft: 2 }}
                          >
                            Recipient must log in to this account to decide.
                          </div>
                        </div>
                      )}
                    </Fragment>
                  );
                })}
              </div>
            </div>

            {/* Expires in */}
            <div style={{ marginTop: 22 }}>
              <div
                className="text-[14px] font-semibold"
                style={{ color: "var(--gw-t3)", marginBottom: 11 }}
              >
                Expires in
              </div>
              <div className="flex items-center" style={{ gap: 12 }}>
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
                  {EXPIRY_OPTIONS.map((opt) => (
                    <SegmentedChip
                      key={opt.key}
                      label={opt.label}
                      active={expiry === opt.key}
                      onClick={() => setExpiry(opt.key)}
                    />
                  ))}
                </div>
                {expiry === "custom" && (
                  <div className="flex items-center" style={{ gap: 9 }}>
                    <input
                      value={customHours}
                      onChange={(e) => setCustomHours(e.target.value.replace(/[^0-9]/g, ""))}
                      inputMode="numeric"
                      className="text-center font-mono"
                      style={{
                        width: 74,
                        background: "var(--gw-inset)",
                        border: "1px solid rgba(var(--gw-line-rgb),.11)",
                        borderRadius: 9,
                        padding: "8px 12px",
                        fontSize: 13,
                        color: "var(--gw-t2)",
                        outline: "none",
                      }}
                      {...FOCUS_RING}
                    />
                    <span className="text-[13px]" style={{ color: "var(--gw-t6)" }}>
                      hrs
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div
              className="flex items-center justify-end"
              style={{ marginTop: 26, gap: 14 }}
            >
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
                Cancel
              </button>
              <button
                type="button"
                onClick={() => createMutation.mutate()}
                disabled={!canGenerate}
                className="cursor-pointer border-none transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  height: 44,
                  padding: "0 22px",
                  borderRadius: 11,
                  background: "var(--gw-green)",
                  color: "var(--gw-green-ink)",
                  fontSize: 14,
                  fontWeight: 600,
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--gw-green-h)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "var(--gw-green)")}
              >
                {createMutation.isPending ? "Generating…" : "Generate link"}
              </button>
            </div>
          </>
        )}

        {isManage && (
          <ShareManagePanel
            review={review}
            activeToken={activeToken}
            createdUrl={createdUrl}
            onCopy={copyLink}
            onExtend={(hours) => extendMutation.mutate({ hours })}
            onRevoke={() => revokeMutation.mutate()}
            revokePending={revokeMutation.isPending}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}

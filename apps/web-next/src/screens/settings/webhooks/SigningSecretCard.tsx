/**
 * Signing secret card — the top of the Webhooks pane (manifest §2.5, S5.1).
 *
 * This section used to live on ProjectPane; it moved here because it is
 * webhook configuration, not project configuration (ProjectPane's own
 * comment records the move, `maskedHmacSecret` stays exported from
 * project-logic.ts for this file to reuse rather than duplicate).
 *
 * Behavior ported verbatim from the pre-move ProjectPane implementation:
 * reveal, hide, copy-with-check-feedback, and rotate behind a glass
 * inline-confirm popover with the exact warning copy below. Only the shell
 * is new (CARD_SHELL + padlock icon + ActionLink, per the prototype).
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import {
  getHmacSecretPreview,
  revealHmacSecretMutation,
  rotateHmacSecretMutation,
} from "@gatewerk/web-core/api/projects";
import { GhostButton, IconButton } from "../../templates/_ui";
import { ActionLink, CARD_SHELL } from "../_shared/ui";
import { maskedHmacSecret } from "../project/project-logic";

export function SigningSecretCard() {
  const queryClient = useQueryClient();

  const { data: hmacPreview } = useQuery(getHmacSecretPreview({}));
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [hmacCopied, setHmacCopied] = useState(false);
  const [rotateConfirm, setRotateConfirm] = useState(false);
  const rotateRef = useRef<HTMLDivElement>(null);

  // Escape closes the rotate confirm at capture, so nothing underneath it
  // (there is nothing underneath it on this pane, but the pattern matches
  // WebhookRow's own menu so Escape behaves the same way everywhere on
  // this screen) reacts to the same keypress.
  useEffect(() => {
    if (!rotateConfirm) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setRotateConfirm(false);
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [rotateConfirm]);

  function onError(err: unknown) {
    toast.error(err instanceof Error ? err.message : "Request failed");
  }

  const revealMutation = useMutation({
    mutationFn: revealHmacSecretMutation,
    onSuccess: (response) => setRevealedSecret(response.hmac_secret),
    onError,
  });

  const rotateMutation = useMutation({
    mutationFn: rotateHmacSecretMutation,
    onSuccess: (response) => {
      setRevealedSecret(response.hmac_secret);
      setRotateConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ["settings", "hmac-secret"] });
      toast.success("Signing secret rotated");
    },
    onError,
  });

  function copySecret() {
    if (!revealedSecret) return;
    navigator.clipboard.writeText(revealedSecret).then(
      () => {
        setHmacCopied(true);
        toast.success("Signing secret copied");
        setTimeout(() => setHmacCopied(false), 2000);
      },
      () => toast.error("Failed to copy"),
    );
  }

  const hasHmacSecret = hmacPreview?.has_secret ?? false;
  const maskedSecret = hmacPreview ? maskedHmacSecret(hmacPreview.prefix) : "";
  const displayValue = hasHmacSecret ? (revealedSecret ?? maskedSecret) : "Not set";

  return (
    <div style={CARD_SHELL}>
      <div className="flex items-start gap-3">
        <Lock
          size={17}
          strokeWidth={1.7}
          className="mt-0.5 shrink-0"
          style={{ color: "var(--gw-blue-t)" }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] font-medium" style={{ color: "var(--gw-t2)" }}>
              Signing secret
            </span>
            <div className="flex shrink-0 items-center gap-3">
              {hasHmacSecret && !revealedSecret && (
                <ActionLink
                  ariaLabel="Reveal signing secret"
                  onClick={() => {
                    if (!revealMutation.isPending) revealMutation.mutate({});
                  }}
                >
                  {revealMutation.isPending ? "Revealing…" : "Reveal"}
                </ActionLink>
              )}
              {revealedSecret && (
                <>
                  <ActionLink ariaLabel="Hide signing secret" onClick={() => setRevealedSecret(null)}>
                    Hide
                  </ActionLink>
                  <IconButton title="Copy signing secret" onClick={copySecret} size={24}>
                    {hmacCopied ? (
                      <Check size={13} strokeWidth={2} style={{ color: "var(--gw-green-t)" }} />
                    ) : (
                      <Copy size={13} strokeWidth={1.9} />
                    )}
                  </IconButton>
                </>
              )}
              <div ref={rotateRef} className="relative">
                <GhostButton onClick={() => setRotateConfirm(true)} disabled={rotateMutation.isPending} height={26}>
                  Rotate
                </GhostButton>

                {rotateConfirm && (
                  <>
                    <div className="fixed inset-0 z-[39]" onClick={() => setRotateConfirm(false)} />
                    <div
                      className="absolute right-0 z-[40] mt-1.5 flex flex-col gap-2.5 p-3"
                      style={{
                        top: "100%",
                        width: 280,
                        background: "rgba(var(--gw-modal-rgb),.96)",
                        backdropFilter: "blur(18px) saturate(140%)",
                        WebkitBackdropFilter: "blur(18px) saturate(140%)",
                        border: "1px solid rgba(var(--gw-line-rgb),.14)",
                        borderRadius: 11,
                        boxShadow: "0 18px 44px rgba(0,0,0,.5), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
                      }}
                    >
                      <span className="text-[12px] leading-relaxed" style={{ color: "var(--gw-t5)" }}>
                        Rotating the signing secret invalidates all existing webhook signatures. Any receiver that
                        still has the old secret will reject deliveries until updated.
                      </span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={rotateMutation.isPending}
                          onClick={() => rotateMutation.mutate({})}
                          className="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[7px] border-none text-[11.5px] font-semibold transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-60"
                          style={{ background: "rgba(var(--gw-red-rgb),.16)", color: "var(--gw-red-t)" }}
                        >
                          {rotateMutation.isPending && <Loader2 size={12} className="animate-spin" />}
                          Rotate secret
                        </button>
                        <button
                          type="button"
                          onClick={() => setRotateConfirm(false)}
                          className="flex h-7 flex-1 cursor-pointer items-center justify-center rounded-[7px] bg-transparent text-[11.5px] font-medium transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)]"
                          style={{ border: "1px solid rgba(var(--gw-line-rgb),.12)", color: "var(--gw-t5)" }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          <code className="mt-1.5 block truncate font-mono text-[12.5px]" style={{ color: "var(--gw-t3)" }}>
            {displayValue}
          </code>

          <p className="mt-2 text-[12px]" style={{ color: "var(--gw-t8)" }}>
            Used to verify webhook payloads. Rotating invalidates existing signatures.
          </p>
        </div>
      </div>
    </div>
  );
}

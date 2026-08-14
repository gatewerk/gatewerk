/**
 * DeleteAccountSection — the live privacy-page promise ("You can delete
 * your account from the app at any time"), in Security's card grammar.
 *
 * Closed, it is one CARD_STYLE row like any other (px-4 py-2.5, neutral
 * border) with a translucent-red trigger button — this codebase has no
 * solid destructive button anywhere (grep across web-next turns up none);
 * rgba(var(--gw-red-rgb),.16) fill + var(--gw-red-t) text is the established
 * language for "destructive action" (ApiKeyRow's confirm-delete button,
 * DetailHeader's delete menu item). The container itself stays neutral —
 * color marks live attention on the action and the warning banner only, not
 * on the row that's merely configuration.
 *
 * Open, the confirm expands INLINE in the same card (never a modal), same
 * treatment RevealedKeyPanel gives its own heightened state: CARD_STYLE with
 * the border swapped to a tinted .32 (amber there for "a secret is on
 * screen", red here for "this is irreversible"). Escape cancels the confirm
 * unless something above it already claimed the keypress at capture (the
 * cascade convention ApiKeyForm and ApiKeyRow's menu both use).
 *
 * Behavior and copy ported from
 * apps/web/src/pages/settings/security/AccountDangerSection.tsx — same two
 * credential paths (password vs email confirmation, decided by
 * GET .../deletion-challenge for OAuth-only accounts with no password to
 * confirm with), same confirm checkbox, same delete → logout → redirect.
 * Its markup and Tailwind classes are apps/web only, rewritten here for
 * web-next's tokens.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { deleteAccount, getDeletionChallenge } from "@gatewerk/web-core/api/account";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { GhostButton, INSET_INPUT_CLASS, INSET_STYLE } from "../../templates/_ui";
import { DANGER_SHELL } from "../_shared/ui";

// The prototype's danger button (manifest S9.6): red outline, fill on hover.
const dangerButtonClass =
  "gw-focus-ring flex shrink-0 cursor-pointer items-center justify-center rounded-[8px] bg-transparent text-[12.5px] font-semibold transition-colors hover:bg-[rgba(var(--gw-red-rgb),0.12)] disabled:cursor-not-allowed disabled:opacity-40";
const dangerButtonStyle = {
  border: "1px solid rgba(var(--gw-red-rgb),.34)",
  color: "var(--gw-red-t)",
  padding: "7px 14px",
} as const;

export function DeleteAccountSection() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  // Asked only once the confirm opens, so this section never pays for it on
  // every settings visit. OAuth only accounts have no password anywhere to
  // confirm with and get an email confirmation field instead.
  const { data: challenge } = useQuery({
    queryKey: ["account", "deletion-challenge"],
    queryFn: getDeletionChallenge,
    enabled: open,
    staleTime: Infinity,
  });
  const needsEmailConfirmation = challenge?.method === "email_confirmation";

  const mutation = useMutation({
    mutationFn: () =>
      deleteAccount(
        needsEmailConfirmation ? { confirm_email: confirmEmail } : { current_password: password },
      ),
    onSuccess: async () => {
      await logout();
      navigate("/login", { replace: true });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Could not delete account");
    },
  });

  function reset() {
    setOpen(false);
    setPassword("");
    setConfirmEmail("");
    setConfirmed(false);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    mutation.mutate();
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      reset();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const credentialProvided = needsEmailConfirmation
    ? confirmEmail.trim().length > 0
    : password.length > 0;
  const canSubmit = credentialProvided && confirmed && !mutation.isPending;

  return (
    <section style={DANGER_SHELL}>
      {!open ? (
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[13.5px] font-semibold" style={{ color: "var(--gw-red-t)" }}>
              Delete account
            </span>
            <span className="text-[12px]" style={{ color: "var(--gw-t7)" }}>
              Permanently delete your account and all associated data. This cannot be undone.
            </span>
          </div>
          <button type="button" onClick={() => setOpen(true)} className={dangerButtonClass} style={dangerButtonStyle}>
            Delete
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <p
            className="m-0 rounded-[9px] px-3 py-2.5 text-[12.5px]"
            style={{
              border: "1px solid rgba(var(--gw-red-rgb),.24)",
              background: "rgba(var(--gw-red-rgb),.09)",
              color: "var(--gw-red-t)",
            }}
          >
            This action is permanent and cannot be undone. All your data will be deleted immediately.
          </p>

          {needsEmailConfirmation ? (
            <div className="flex flex-col gap-1.5">
              <label className="text-[11.5px] font-medium" style={{ color: "var(--gw-t6)" }}>
                Type your email address to confirm
              </label>
              <input
                type="email"
                autoComplete="off"
                autoFocus
                required
                value={confirmEmail}
                onChange={(e) => setConfirmEmail(e.target.value)}
                placeholder="you@example.com"
                className={`${INSET_INPUT_CLASS} w-full`}
                style={INSET_STYLE}
              />
              <span className="text-[11px]" style={{ color: "var(--gw-t7)" }}>
                You sign in with a provider, so there is no password to confirm.
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label className="text-[11.5px] font-medium" style={{ color: "var(--gw-t6)" }}>
                Confirm your password
              </label>
              <input
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Current password"
                className={`${INSET_INPUT_CLASS} w-full`}
                style={INSET_STYLE}
              />
            </div>
          )}

          <label className="flex cursor-pointer items-start gap-2.5 select-none">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              style={{ accentColor: "var(--gw-red-t)" }}
            />
            <span className="text-[11.5px] leading-relaxed" style={{ color: "var(--gw-t7)" }}>
              I understand this action is permanent and cannot be reversed
            </span>
          </label>

          <div className="flex justify-end gap-2">
            <GhostButton onClick={reset} disabled={mutation.isPending}>
              Cancel
            </GhostButton>
            <button type="submit" disabled={!canSubmit} className={dangerButtonClass} style={dangerButtonStyle}>
              {mutation.isPending && <Loader2 size={12} className="mr-1.5 animate-spin" />}
              Permanently delete account
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/**
 * Change-password modal — the voluntary path (PUT /profile with
 * current_password/new_password, distinct from the forced first-login
 * flow at /change-password). Chrome (backdrop, focus trap, escape-layer
 * stack, the reserved title zone) comes from the shared Modal, same as
 * templates/detail's ActionModal. The fields themselves are auth/controls'
 * PasswordInput/FieldLabel, not templates/_ui's INSET_INPUT_CLASS — this is
 * a password form, and that's the component this app already built for
 * exactly that (44px tall, dim border at rest with a soft glow only on real
 * focus, eye toggle), the same one Login/ChangePassword/ResetPassword use.
 * INSET_INPUT_CLASS layers `.gw-focus-ring`'s harder-edged ring on top of a
 * static border — fine for the short option-picker fields it was built for,
 * but on a taller password field it read as a flat, dated outline.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { updateProfile } from "@gatewerk/web-core/api/auth";
import { setToken } from "@gatewerk/web-core/api/client/http";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { Modal } from "~/components/Modal";
import { FieldLabel, PasswordInput } from "~/auth/controls";
import { GhostButton, PrimaryButton } from "../../templates/_ui";
import { CHANGE_COPY, PASSWORD_MIN } from "~/auth/auth-copy";
import { checkPasswordPair } from "~/auth/password-rules";

export function PasswordModal({ onClose }: { onClose: () => void }) {
  const { user, updateUser } = useAuth();
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: (vars: { current_password: string; new_password: string }) => updateProfile(vars),
    onSuccess: (reviewer) => {
      // The server revokes every session and hands back a fresh token for
      // this one — without adopting it, the very next request 401s the
      // reviewer out of the account they just secured.
      if (reviewer.token) setToken(reviewer.token);
      // Merged onto the existing user, not a raw replace: PUT /profile's
      // response omits has_2fa/must_change_password, and TwoFactorSection
      // reads has_2fa straight off this same context — a replace would
      // silently flip its display to "disabled" until the next page load.
      if (user) updateUser({ ...user, ...reviewer });
      toast.success("Password updated");
      onClose();
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : CHANGE_COPY.failed);
    },
  });

  function submit() {
    if (!currentPw) {
      setError("Current password is required");
      return;
    }
    const check = checkPasswordPair(newPw, confirmPw);
    if (!check.ok) {
      setError(
        check.reason === "short" ? CHANGE_COPY.tooShort : check.reason === "long" ? CHANGE_COPY.tooLong : CHANGE_COPY.mismatch,
      );
      return;
    }
    setError("");
    mutation.mutate({ current_password: currentPw, new_password: newPw });
  }

  const canSubmit = !!currentPw && !!newPw && !!confirmPw && !mutation.isPending;

  return (
    <Modal
      onClose={onClose}
      ariaLabel="Change password"
      title="Change password"
      subtitle="Choose a new password for your account."
    >
      <div>
        <FieldLabel htmlFor="pw-current">Current password</FieldLabel>
        <PasswordInput
          id="pw-current"
          autoFocus
          autoComplete="current-password"
          value={currentPw}
          onChange={(e) => setCurrentPw(e.target.value)}
          visible={visible}
          onToggleVisible={() => setVisible(!visible)}
        />
      </div>

      <div>
        <FieldLabel htmlFor="pw-new">New password</FieldLabel>
        <PasswordInput
          id="pw-new"
          autoComplete="new-password"
          placeholder={`At least ${PASSWORD_MIN} characters`}
          value={newPw}
          onChange={(e) => setNewPw(e.target.value)}
          visible={visible}
          onToggleVisible={() => setVisible(!visible)}
        />
      </div>

      <div>
        <FieldLabel htmlFor="pw-confirm">Confirm new password</FieldLabel>
        <PasswordInput
          id="pw-confirm"
          autoComplete="new-password"
          value={confirmPw}
          onChange={(e) => setConfirmPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          visible={visible}
          onToggleVisible={() => setVisible(!visible)}
        />
      </div>

      {error && (
        <p className="text-[11.5px]" style={{ color: "var(--gw-red-t)" }} role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <GhostButton onClick={onClose} disabled={mutation.isPending}>
          Cancel
        </GhostButton>
        <PrimaryButton onClick={submit} disabled={!canSubmit}>
          {mutation.isPending && <Loader2 size={12} className="mr-1.5 animate-spin" />}
          Save password
        </PrimaryButton>
      </div>
    </Modal>
  );
}

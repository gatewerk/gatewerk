/**
 * Change password — the forced first-login change, and only that.
 *
 * `changePassword()` posts `new_password` alone. The server accepts that only
 * while the reviewer still carries `must_change_password`; for anyone else it
 * demands `current_password` and fails with "current_password is required"
 * (apps/api/src/routes/auth.ts:370-378). A voluntary password change is a
 * different flow and lives in Settings, on `updateProfile`.
 *
 * So this screen guards on that flag. apps/web renders the form to anyone who
 * is signed in, which hands a reviewer who wandered here a server error they
 * have no way to satisfy. Not ported.
 *
 * Login sends people here: it redirects on `must_change_password` after both
 * sign in and 2FA. Until this screen existed, that redirect landed on a
 * placeholder, which stranded exactly the users who cannot skip the step.
 */

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { changePassword } from "@gatewerk/web-core/api/auth";
import { setToken } from "@gatewerk/web-core/api/client/http";
import { AuthCard } from "./AuthCard";
import { ErrorBanner, FieldLabel, PasswordInput, PrimaryBtn } from "./controls";
import { CHANGE_COPY as C } from "./auth-copy";
import { canSubmitPassword, checkPasswordPair } from "./password-rules";

export default function ChangePassword() {
  const { isLoggedIn, user, updateUser } = useAuth();
  const navigate = useNavigate();

  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.title = "Set your password · Gatewerk";
  }, []);

  // `user` is null for a beat while auth bootstraps, so the second condition
  // waits for it rather than bouncing a legitimate arrival to the inbox.
  useEffect(() => {
    if (!isLoggedIn) {
      navigate("/login", { replace: true });
      return;
    }
    if (user && !user.must_change_password) {
      navigate("/", { replace: true });
    }
  }, [isLoggedIn, user, navigate]);

  const mismatch = confirm.length > 0 && newPassword !== confirm;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    const check = checkPasswordPair(newPassword, confirm);
    if (!check.ok) {
      setError(
        check.reason === "short" ? C.tooShort : check.reason === "long" ? C.tooLong : C.mismatch,
      );
      return;
    }

    setLoading(true);
    try {
      const res = await changePassword(newPassword);
      if (!res.token || !res.reviewer) {
        throw new Error("Password change succeeded but the server response is missing a token or reviewer");
      }
      setToken(res.token);
      // The server clears the flag; mirroring it locally stops the guard above
      // from firing on the way out.
      updateUser({ ...res.reviewer, must_change_password: false });
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : C.failed);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard title={C.title} sub={C.sub}>
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <FieldLabel htmlFor="new-password">{C.newLabel}</FieldLabel>
          <PasswordInput
            id="new-password"
            required
            autoFocus
            autoComplete="new-password"
            placeholder={C.newPlaceholder}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            visible={visible}
            onToggleVisible={() => setVisible(!visible)}
          />
        </div>

        <div>
          <FieldLabel htmlFor="confirm-password">{C.confirmLabel}</FieldLabel>
          <PasswordInput
            id="confirm-password"
            required
            autoComplete="new-password"
            placeholder={C.confirmPlaceholder}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            visible={visible}
            onToggleVisible={() => setVisible(!visible)}
          />
          {mismatch && (
            <p style={{ margin: "7px 0 0", fontSize: 12, color: "var(--gw-red-t)" }}>
              {C.mismatch}
            </p>
          )}
        </div>

        <PrimaryBtn loading={loading} disabled={!canSubmitPassword(newPassword, confirm)}>
          {C.submit}
        </PrimaryBtn>
      </form>
    </AuthCard>
  );
}

/**
 * Reset password — the landing page for the emailed reset link.
 *
 * Public route. The token arrives as `?token=`, which the API mints in
 * apps/api/src/routes/account.ts:202 and validates on POST /reset-password.
 *
 * The length rule here is 12, not 8. apps/web's version validated at 8 and
 * enabled its button at 8 while the server has required 12 the whole time
 * (apps/api/src/lib/password-policy.ts:4), so a password of 8 to 11 characters
 * was accepted by the form, told the user "At least 8 characters required" when
 * it was short, and then rejected by the server. Not ported.
 */

import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { CheckCircle2 } from "lucide-react";
import { resetPassword } from "@gatewerk/web-core/api/account";
import { AuthCard } from "./AuthCard";
import { CardState, ErrorBanner, PasswordInput, PrimaryBtn, TextLink } from "./controls";
import { PASSWORD_MIN, RESET_COPY as C } from "./auth-copy";
import { canSubmitPassword, checkPassword } from "./password-rules";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  // Only complain once they have typed something. An empty field is not an
  // error yet, it is just an empty field.
  const check = checkPassword(password);
  const tooShort = password.length > 0 && !check.ok && check.reason === "short";
  const tooLong = !check.ok && check.reason === "long";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) {
      setError(C.missingToken);
      return;
    }
    if (!check.ok) {
      setError(check.reason === "long" ? C.tooLong : C.tooShort);
      return;
    }
    setError("");
    setLoading(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      // The server's own message is preferred: it is the only thing that can
      // say "this password appeared in a data breach".
      setError(err instanceof Error ? err.message : C.failed);
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <AuthCard title={C.title} sub={C.sub}>
        <CardState
          icon={<CheckCircle2 size={22} style={{ color: "var(--gw-green-d)" }} />}
          heading={C.doneHeading}
          body={C.doneBody}
        >
          <div style={{ width: "100%", marginTop: 4 }}>
            <PrimaryBtn type="button" onClick={() => navigate("/login", { replace: true })}>
              {C.doneAction}
            </PrimaryBtn>
          </div>
        </CardState>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={C.title} sub={C.sub}>
      {!token && <ErrorBanner>{C.missingToken}</ErrorBanner>}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <PasswordInput
            required
            autoFocus
            autoComplete="new-password"
            placeholder={C.passwordPlaceholder}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            visible={visible}
            onToggleVisible={() => setVisible(!visible)}
          />
          {tooShort && (
            <p style={{ margin: "7px 0 0", fontSize: 12, color: "var(--gw-red-t)" }}>
              {C.tooShort}
            </p>
          )}
          {tooLong && (
            <p style={{ margin: "7px 0 0", fontSize: 12, color: "var(--gw-red-t)" }}>
              {C.tooLong}
            </p>
          )}
        </div>

        <PrimaryBtn loading={loading} disabled={!token || !canSubmitPassword(password)}>
          {C.submit}
        </PrimaryBtn>

        <TextLink onClick={() => navigate("/login")}>{C.backToSignIn}</TextLink>
      </form>
    </AuthCard>
  );
}

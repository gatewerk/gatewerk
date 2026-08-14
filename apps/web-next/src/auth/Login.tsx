/**
 * Login page — states: login | twofa | forgot | sent + error banner + return-to.
 * Design source: Gatewerk Login.dc.html from the full-app design handoff (verbatim
 * copy, focus is neutral, primary btn green, remember-me pill toggle).
 * Auth layer reused from @/hooks/use-auth + @/api/two-factor + @/api/account.
 */

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ShieldCheck, Mail } from "lucide-react";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { validate2FA } from "@gatewerk/web-core/api/two-factor";
import { forgotPassword } from "@gatewerk/web-core/api/account";
import { setToken } from "@gatewerk/web-core/api/client/http";
import { getMe } from "@gatewerk/web-core/api/auth";
import { AuthCard } from "./AuthCard";
import { AUTH_COPY as C } from "./auth-copy";
import {
  CardState,
  ErrorBanner,
  FocusInput,
  PasswordInput,
  PrimaryBtn,
  TextLink,
  focusStyle,
  inputBase,
} from "./controls";

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Client-side mirror of server-side return_to validation.
 * Server is the authoritative chokepoint (OWASP A01:2021); this is defense-in-depth.
 *
 * The two allowed targets and the deny rules below must stay in lockstep with
 * `validateReturnTo` in apps/api/src/routes/auth.ts. Widening only this side
 * changes nothing, because the server strips an unlisted return_to out of the
 * login response and it never comes back. Change both, or neither.
 *
 * `/reviews/<id>` is the second entry: it is where the "your turn" email
 * points, so a signed-out reviewer needs it here to land back after login.
 */
const RETURN_TO_REVIEW_PATTERN = /^\/reviews\/[A-Za-z0-9_-]+$/;

function isValidReturnTo(value: string | null): value is string {
  if (!value) return false;
  if (!value.startsWith("/r/") && !RETURN_TO_REVIEW_PATTERN.test(value)) return false;
  if (value.includes("..") || value.includes("//") || value.includes("\\")) return false;
  if (/^[a-z][a-z0-9+\-.]*:/i.test(value)) return false;
  return true;
}

// Input, button, link, banner and card-state primitives live in ./controls —
// Reset password, Change password and Accept invite render the same ones.

function BackLink({ onClick }: { onClick: () => void }) {
  return <TextLink onClick={onClick}>{C.backToSignIn}</TextLink>;
}

// ── state type ────────────────────────────────────────────────────────────────

type LoginState = "login" | "twofa" | "forgot" | "sent";

// ── main component ────────────────────────────────────────────────────────────

export default function Login() {
  const { login, isLoggedIn, user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const safeReturnTo = (() => {
    const raw = searchParams.get("return_to");
    return isValidReturnTo(raw) ? raw : null;
  })();
  const hasReturnTo = !!searchParams.get("return_to") && !!safeReturnTo;

  // Redirect already-authenticated users
  useEffect(() => {
    if (isLoggedIn) {
      if (user?.must_change_password) {
        navigate("/change-password", { replace: true });
      } else {
        navigate(safeReturnTo ?? "/", { replace: true });
      }
    }
  }, [isLoggedIn, user, navigate, safeReturnTo]);

  useEffect(() => {
    document.title = "Sign in · Gatewerk";
  }, []);

  const [view, setView] = useState<LoginState>("login");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Login fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(false);

  // 2FA fields
  const [loginTicket, setLoginTicket] = useState("");
  const [code, setCode] = useState("");

  // Forgot fields
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);

  // Escape returns to login from 2FA or forgot.
  // setView/setError/setCode/setForgotEmail are stable setter references — omitting
  // them from deps is safe (React guarantees setState identity is stable).
  useEffect(() => {
    if (view !== "twofa" && view !== "forgot") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setView("login");
        setError("");
        setCode("");
        setForgotEmail("");
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [view]);

  function backToLogin() {
    setView("login");
    setError("");
    setCode("");
    setForgotEmail("");
  }

  // ── login submit ────────────────────────────────────────────────────────────
  async function handleSignIn(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await login(email, password, remember, safeReturnTo ?? undefined);
      if (result.requires_2fa && result.login_ticket) {
        setLoginTicket(result.login_ticket);
        setView("twofa");
        return;
      }
      if (result.must_change_password) {
        navigate("/change-password", { replace: true });
      } else {
        navigate(safeReturnTo ?? "/", { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  // ── 2FA submit ──────────────────────────────────────────────────────────────
  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await validate2FA(loginTicket, code);
      setToken(res.token, remember);
      // Re-bootstrap auth context then navigate
      await getMe();
      window.location.href = safeReturnTo ?? "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  // ── forgot submit ───────────────────────────────────────────────────────────
  async function handleSendReset(e: FormEvent) {
    e.preventDefault();
    setForgotLoading(true);
    try {
      await forgotPassword(forgotEmail);
    } catch {
      // Always show sent to avoid email enumeration
    } finally {
      setForgotLoading(false);
      setView("sent");
    }
  }

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <AuthCard title={C.title} sub={view === "login" ? C.sub : undefined}>
      {/* Error banner */}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {view === "login" && (
        <LoginForm
          email={email}
          setEmail={setEmail}
          password={password}
          setPassword={setPassword}
          showPw={showPw}
          setShowPw={setShowPw}
          remember={remember}
          setRemember={setRemember}
          loading={loading}
          hasReturnTo={hasReturnTo}
          onSubmit={handleSignIn}
          onForgot={() => { setForgotEmail(email); setError(""); setView("forgot"); }}
        />
      )}

      {view === "twofa" && (
        <TwofaForm
          code={code}
          setCode={setCode}
          loading={loading}
          onSubmit={handleVerify}
          onBack={backToLogin}
        />
      )}

      {view === "forgot" && (
        <ForgotForm
          forgotEmail={forgotEmail}
          setForgotEmail={setForgotEmail}
          loading={forgotLoading}
          onSubmit={handleSendReset}
          onBack={backToLogin}
        />
      )}

      {view === "sent" && (
        <SentState onBack={backToLogin} />
      )}
    </AuthCard>
  );
}

// ── login form ────────────────────────────────────────────────────────────────

function LoginForm({
  email, setEmail, password, setPassword,
  showPw, setShowPw, remember, setRemember,
  loading, hasReturnTo, onSubmit, onForgot,
}: {
  email: string; setEmail: (v: string) => void;
  password: string; setPassword: (v: string) => void;
  showPw: boolean; setShowPw: (v: boolean) => void;
  remember: boolean; setRemember: (v: boolean) => void;
  loading: boolean; hasReturnTo: boolean;
  onSubmit: (e: FormEvent) => void;
  onForgot: () => void;
}) {
  return (
    <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {hasReturnTo && (
        <p style={{ margin: "0 0 0", fontSize: 12, color: "var(--gw-t5)" }}>
          {AUTH_COPY_RETURN_NOTE}
        </p>
      )}

      <div>
        <label htmlFor="login-email" className="sr-only">
          Email
        </label>
        <FocusInput
          id="login-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          autoFocus
          placeholder={C.emailPlaceholder}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="login-password" className="sr-only">
          Password
        </label>
        <PasswordInput
          id="login-password"
          name="password"
          required
          autoComplete="current-password"
          placeholder={C.passwordPlaceholder}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          visible={showPw}
          onToggleVisible={() => setShowPw(!showPw)}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 9 }}>
          <ForgotLink onClick={onForgot} />
        </div>
      </div>

      {/* Remember me pill toggle */}
      <div
        role="switch"
        aria-checked={remember}
        tabIndex={0}
        onClick={() => setRemember(!remember)}
        onKeyDown={(e) => e.key === "Enter" && setRemember(!remember)}
        style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none" }}
      >
        <span
          style={{
            width: 36,
            height: 20,
            borderRadius: 11,
            padding: 2,
            display: "flex",
            flexShrink: 0,
            transition: "background .15s",
            // Neutral-on: the screen's one green element is the Sign in
            // button — the action that commits.
            background: remember ? "rgba(var(--gw-line-rgb),.45)" : "rgba(var(--gw-line-rgb),.12)",
            justifyContent: remember ? "flex-end" : "flex-start",
          }}
        >
          <span style={{ width: 16, height: 16, borderRadius: "50%", background: "var(--gw-panel-a)" }} />
        </span>
        <span style={{ fontSize: 12.5, color: "var(--gw-t6)" }}>{C.rememberLabel}</span>
      </div>

      <PrimaryBtn loading={loading}>{C.signInButton}</PrimaryBtn>
    </form>
  );
}

// tiny re-export to avoid "AUTH_COPY_RETURN_NOTE" inlining
const AUTH_COPY_RETURN_NOTE = C.returnToNote;

function ForgotLink({ onClick }: { onClick: () => void }) {
  return (
    <TextLink onClick={onClick} block={false}>
      {C.forgotLink}
    </TextLink>
  );
}

// ── 2FA form ──────────────────────────────────────────────────────────────────

function TwofaForm({
  code, setCode, loading, onSubmit, onBack,
}: {
  code: string; setCode: (v: string) => void;
  loading: boolean;
  onSubmit: (e: FormEvent) => void;
  onBack: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, paddingBottom: 2 }}>
        <ShieldCheck size={30} style={{ color: "var(--gw-green-d)" }} />
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--gw-t1)" }}>{C.twofaHeading}</div>
        <div style={{ fontSize: 12, color: "var(--gw-t8)", textAlign: "center" }}>{C.twofaSub}</div>
      </div>
      <label htmlFor="login-2fa" className="sr-only">
        One-time code
      </label>
      <input
        id="login-2fa"
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        required
        maxLength={8}
        placeholder={C.twofaPlaceholder}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          ...inputBase,
          fontFamily: "var(--font-mono), monospace",
          fontSize: 16,
          letterSpacing: "0.4em",
          textAlign: "center",
          ...(focused ? focusStyle : {}),
        }}
      />
      <PrimaryBtn loading={loading} disabled={code.length < 6}>{C.verifyButton}</PrimaryBtn>
      <BackLink onClick={onBack} />
    </form>
  );
}

// ── forgot form ───────────────────────────────────────────────────────────────

function ForgotForm({
  forgotEmail, setForgotEmail, loading, onSubmit, onBack,
}: {
  forgotEmail: string; setForgotEmail: (v: string) => void;
  loading: boolean;
  onSubmit: (e: FormEvent) => void;
  onBack: () => void;
}) {
  return (
    <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--gw-t1)" }}>{C.forgotHeading}</div>
        <div style={{ fontSize: 12, color: "var(--gw-t8)" }}>{C.forgotSub}</div>
      </div>
      <FocusInput
        type="email"
        required
        autoFocus
        placeholder={C.emailPlaceholder}
        value={forgotEmail}
        onChange={(e) => setForgotEmail(e.target.value)}
      />
      <PrimaryBtn loading={loading} disabled={!forgotEmail}>{C.sendResetButton}</PrimaryBtn>
      <BackLink onClick={onBack} />
    </form>
  );
}

// ── sent state ────────────────────────────────────────────────────────────────

function SentState({ onBack }: { onBack: () => void }) {
  return (
    <CardState
      icon={<Mail size={22} style={{ color: "var(--gw-green-d)" }} />}
      heading={C.sentHeading}
      body={C.sentBody}
    >
      <TextLink onClick={onBack}>{C.backToSignIn}</TextLink>
    </CardState>
  );
}

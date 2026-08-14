/**
 * EmailOtpSteps — the two email-OTP gates a recipient passes before the review.
 *
 * Spec §2 (email) and §3 (code). Design: Gatewerk External Review.dc.html:44-66.
 * Focus is NEUTRAL everywhere (brightened line + soft light ring), never green.
 */

import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft } from "lucide-react";

// ── shared bits ──────────────────────────────────────────────────────────────

const FIELD_BASE: React.CSSProperties = {
  width: "100%",
  // Theme inset rather than the prototype's rgba(0,0,0,.2): black alpha reads
  // as flat gray on the cream light theme.
  background: "var(--gw-inset)",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "rgba(var(--gw-line-rgb),.12)",
  borderRadius: 11,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
  transition: "border-color .12s, box-shadow .12s",
};

const FOCUS: React.CSSProperties = {
  borderColor: "rgba(var(--gw-line-rgb),.28)",
  boxShadow: "0 0 0 3px rgba(var(--gw-line-rgb),.06)",
};

function FocusInput({
  style,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      {...props}
      style={{ ...FIELD_BASE, ...style, ...(focused ? FOCUS : {}) }}
      onFocus={(e) => {
        setFocused(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        props.onBlur?.(e);
      }}
    />
  );
}

function PrimaryButton({
  label,
  pending,
  disabled,
}: {
  label: string;
  pending?: boolean;
  disabled?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="submit"
      className="gw-focus-ring"
      disabled={disabled || pending}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: "100%",
        height: 44,
        borderRadius: 11,
        border: "none",
        background: hovered ? "var(--gw-green-h)" : "var(--gw-green)",
        color: "var(--gw-green-ink)",
        fontFamily: "inherit",
        fontSize: 14,
        fontWeight: 600,
        cursor: pending ? "default" : "pointer",
        opacity: pending ? 0.85 : 1,
      }}
    >
      {label}
    </button>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11.5, color: "var(--gw-t8)" }}>{children}</div>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11.5, color: "var(--gw-red-t)", marginTop: 8 }}>
      {children}
    </div>
  );
}

function StepTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--gw-t1)" }}>
      {children}
    </div>
  );
}

// ── §2 · email step ──────────────────────────────────────────────────────────

interface EmailStepProps {
  email: string;
  onEmail: (v: string) => void;
  onSubmit: () => void;
  pending: boolean;
  error: string | null;
  sessionExpired: boolean;
  emailHint: string;
  senderHint?: string;
}

export function EmailStep({
  email,
  onEmail,
  onSubmit,
  pending,
  error,
  sessionExpired,
  emailHint,
  senderHint,
}: EmailStepProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!pending) onSubmit();
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-col"
      style={{ gap: 15 }}
      noValidate
    >
      <StepTitle>Verify your email to continue</StepTitle>

      <div className="flex flex-col" style={{ gap: 8 }}>
        <FocusInput
          type="email"
          value={email}
          onChange={(e) => onEmail(e.target.value)}
          placeholder="you@company.com"
          autoComplete="email"
          autoFocus
          style={{
            padding: "12px 14px",
            fontSize: 14,
            color: "var(--gw-t2)",
          }}
        />
        <Hint>
          A 6‑digit code will be sent to the address on file · {emailHint}
        </Hint>
        {sessionExpired && (
          <div style={{ fontSize: 11.5, color: "var(--gw-t8)" }}>
            Your previous session expired. Please re-verify your email.
          </div>
        )}
        {error && <ErrorLine>{error}</ErrorLine>}
      </div>

      <PrimaryButton
        label={pending ? "Sending…" : "Send verification code"}
        pending={pending}
        disabled={email.trim().length === 0}
      />

      {senderHint && (
        <div
          style={{ fontSize: 11.5, color: "var(--gw-t10)", textAlign: "center" }}
        >
          Sent by {senderHint} · Human oversight for AI agents
        </div>
      )}
    </form>
  );
}

// ── §3 · code step ───────────────────────────────────────────────────────────

function ResendLine({
  cooldownEndsAt,
  pending,
  onResend,
}: {
  cooldownEndsAt: number;
  pending: boolean;
  onResend: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secondsLeft = Math.max(0, Math.ceil((cooldownEndsAt - now) / 1000));

  const base: React.CSSProperties = {
    fontSize: 12,
    color: "var(--gw-t10)",
    textAlign: "center",
  };

  if (pending) return <div style={base}>Sending…</div>;
  if (secondsLeft > 0)
    return <div style={base}>Didn&apos;t receive it? Resend in {secondsLeft}s</div>;

  return (
    <div style={base}>
      <button
        type="button"
        onClick={onResend}
        className="gw-focus-ring cursor-pointer border-none bg-transparent p-0"
        style={{ fontFamily: "inherit", fontSize: 12, color: "var(--gw-t4)" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gw-t1)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--gw-t4)")}
      >
        Resend code
      </button>
    </div>
  );
}

interface CodeStepProps {
  code: string;
  onCode: (v: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  onResend: () => void;
  pending: boolean;
  resendPending: boolean;
  error: string | null;
  emailHint: string;
  cooldownEndsAt: number;
}

export function CodeStep({
  code,
  onCode,
  onSubmit,
  onBack,
  onResend,
  pending,
  resendPending,
  error,
  emailHint,
  cooldownEndsAt,
}: CodeStepProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!pending && code.length === 6) onSubmit();
  };
  return (
    <form onSubmit={submit} className="flex flex-col" style={{ gap: 15 }}>
      <button
        type="button"
        onClick={onBack}
        className="gw-focus-ring inline-flex cursor-pointer items-center border-none bg-transparent p-0"
        style={{
          gap: 6,
          fontFamily: "inherit",
          fontSize: 12,
          color: "var(--gw-t8)",
          width: "max-content",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gw-t4)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--gw-t8)")}
      >
        <ArrowLeft size={13} strokeWidth={2} />
        Use a different email
      </button>

      <StepTitle>Enter the 6‑digit code</StepTitle>

      <div className="flex flex-col" style={{ gap: 8 }}>
        <FocusInput
          value={code}
          onChange={(e) => onCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          maxLength={6}
          placeholder="000000"
          autoComplete="one-time-code"
          autoFocus
          className="font-mono"
          style={{
            padding: 14,
            fontSize: 22,
            letterSpacing: ".5em",
            textAlign: "center",
            color: "var(--gw-t1)",
          }}
        />
        <Hint>Sent to {emailHint} · code expires in 10 minutes.</Hint>
        {error && <ErrorLine>{error}</ErrorLine>}
      </div>

      <PrimaryButton
        label={pending ? "Verifying…" : "Verify"}
        pending={pending}
        disabled={code.length !== 6}
      />

      <ResendLine
        cooldownEndsAt={cooldownEndsAt}
        pending={resendPending}
        onResend={onResend}
      />
    </form>
  );
}

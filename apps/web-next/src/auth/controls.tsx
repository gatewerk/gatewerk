/**
 * Shared controls for the auth screens (Login, Reset password, Change password,
 * Accept invite).
 *
 * These started life inside Login.tsx. They live here because four screens now
 * render the same input, the same green primary button and the same error
 * banner, and a copy per screen is how apps/web and web-next drifted apart in
 * the first place.
 *
 * Design source: Gatewerk Login.dc.html. Values are inline styles over the
 * --gw-* custom properties rather than Tailwind utilities, matching the rest of
 * the auth surface.
 */

import { useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";

// ── style primitives ─────────────────────────────────────────────────────────

export const inputBase: CSSProperties = {
  height: 44,
  width: "100%",
  borderRadius: 11,
  // Longhand (not the `border` shorthand) so focusStyle's borderColor override
  // does not conflict on rerender (React shorthand/longhand mixing warning).
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "rgba(var(--gw-line-rgb),.12)",
  background: "var(--gw-inset)",
  padding: "0 14px",
  fontFamily: "inherit",
  fontSize: 14,
  color: "var(--gw-t1)",
  outline: "none",
  boxSizing: "border-box",
  transition: "border-color .12s, box-shadow .12s",
};

export const focusStyle = {
  borderColor: "rgba(var(--gw-line-rgb),.3)",
  boxShadow: "0 0 0 3px rgba(var(--gw-line-rgb),.06)",
};

const primaryBtnBase: CSSProperties = {
  width: "100%",
  height: 44,
  borderRadius: 11,
  border: "none",
  background: "var(--gw-green)",
  color: "var(--gw-green-ink)",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  boxShadow: "0 6px 18px rgba(var(--gw-green-rgb),.18)",
  transition: "background .14s, transform .1s",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
};

// ── controls ─────────────────────────────────────────────────────────────────

export function FocusInput({ style, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      {...props}
      style={{ ...inputBase, ...style, ...(focused ? focusStyle : {}) }}
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

/**
 * Password field with the show/hide eye. `visible` is lifted so a screen with
 * two password fields (Change password, Accept invite) reveals both at once
 * rather than tracking a toggle per field.
 */
export function PasswordInput({
  visible,
  onToggleVisible,
  style,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  visible: boolean;
  onToggleVisible: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <input
        {...props}
        type={visible ? "text" : "password"}
        style={{ ...inputBase, paddingRight: 42, ...style, ...(focused ? focusStyle : {}) }}
        onFocus={(e) => {
          setFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          props.onBlur?.(e);
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={visible ? "Hide password" : "Show password"}
        onClick={onToggleVisible}
        style={{
          position: "absolute",
          right: 12,
          top: "50%",
          transform: "translateY(-50%)",
          color: "var(--gw-t8)",
          cursor: "pointer",
          display: "flex",
          background: "none",
          border: "none",
          padding: 0,
        }}
      >
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

export function PrimaryBtn({
  loading,
  disabled,
  children,
  type = "submit",
  onClick,
}: {
  loading?: boolean;
  disabled?: boolean;
  children: ReactNode;
  type?: "submit" | "button";
  onClick?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        ...primaryBtnBase,
        // A disabled primary goes NEUTRAL, not faded. Dimming green leaves a
        // green button, which still reads as the thing to press — and on the
        // light theme a 60%-opacity green is simply a paler green, so the one
        // control on screen that cannot be used looks like the one that can.
        // Loading is different: the action IS live, so it keeps its colour and
        // says so with the spinner.
        background: disabled && !loading
          ? "rgba(var(--gw-hi-rgb),.08)"
          : hovered
            ? "var(--gw-green-h)"
            : "var(--gw-green)",
        color: disabled && !loading ? "var(--gw-t9)" : "var(--gw-green-ink)",
        boxShadow: disabled && !loading ? "none" : primaryBtnBase.boxShadow,
        transform: pressed ? "scale(.98)" : undefined,
        opacity: loading ? 0.75 : 1,
        cursor: disabled || loading ? "not-allowed" : "pointer",
      }}
    >
      {loading && <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} />}
      {children}
    </button>
  );
}

/**
 * The quiet text action under a card. Login uses it for "Back to sign in" and
 * "Forgot password?"; the password screens use it to get back to /login.
 */
export function TextLink({
  onClick,
  children,
  block = true,
}: {
  onClick: () => void;
  children: ReactNode;
  block?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        textAlign: block ? "center" : undefined,
        display: block ? "block" : undefined,
        fontSize: 12,
        color: hovered ? "var(--gw-t4)" : "var(--gw-t8)",
        cursor: "pointer",
        transition: "color .12s",
      }}
    >
      {children}
    </span>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        marginBottom: 16,
        display: "flex",
        alignItems: "flex-start",
        gap: 9,
        border: "1px solid rgba(var(--gw-red-rgb),.24)",
        background: "rgba(var(--gw-red-rgb),.09)",
        borderRadius: 11,
        padding: "10px 12px",
        fontSize: 12.5,
        color: "var(--gw-red-t)",
      }}
    >
      <span style={{ flexShrink: 0 }}>&times;</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * Centred icon + heading + body, used for terminal states inside the card
 * (Login's "Check your inbox", Reset password's "Password updated").
 */
export function CardState({
  icon,
  heading,
  body,
  children,
}: {
  icon: ReactNode;
  heading: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: 14,
        padding: "6px 0",
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 14,
          background: "rgba(var(--gw-green-rgb),.14)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {icon}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--gw-t1)" }}>{heading}</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--gw-t6)", maxWidth: 280 }}>
        {body}
      </div>
      {children}
    </div>
  );
}

/**
 * Field label above an input. The password screens label their fields; Login
 * relies on placeholders alone, per its design source.
 */
export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: "block",
        marginBottom: 7,
        fontSize: 12,
        fontWeight: 500,
        color: "var(--gw-t6)",
      }}
    >
      {children}
    </label>
  );
}

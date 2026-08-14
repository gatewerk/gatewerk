/**
 * Accept invite — the public landing page for an emailed invite link.
 *
 * Three phases beside a constant brand panel, per the onboarding design:
 * accept (who invited you, to what) → name (+ password) → entering.
 *
 * The password field is the design's own open question #1, answered its
 * recommended way: `acceptInvite` requires a password, and shipping the
 * name-only screen the prototype draws would 422 on every submit. One field
 * rather than a confirm pair — the reveal toggle covers the typo case, and this
 * screen is already asking a stranger for two things they did not plan to give.
 *
 * The API returns inviter_name/team_name as nullable (the inviter's row may be
 * gone, or no project may exist yet). Both are rendered as absent rather than
 * invented: a screen that says "null invited you" is worse than one that says
 * you have been invited.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { AlertCircle, Check } from "lucide-react";
import { acceptInvite, validateInviteToken } from "@gatewerk/web-core/api/auth";
import { setToken } from "@gatewerk/web-core/api/client/http";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { EmptyStateCore, StatusPill } from "~/components/empty-state";
import { InviteBrandPanel } from "./InviteBrandPanel";
import { ErrorBanner, FieldLabel, FocusInput, PasswordInput, PrimaryBtn, TextLink } from "./controls";
import { INVITE_COPY as C } from "./auth-copy";
import { canSubmitPassword, checkPassword, inviteStateFromError } from "./password-rules";

type PageState = "loading" | "ready" | "expired" | "used" | "invalid" | "error";
type Phase = "accept" | "name" | "entering";

type Invite = {
  email: string;
  role: string;
  inviter_name: string | null;
  team_name: string | null;
};

/** The two-panel frame. Every phase renders inside it, including the dead ends. */
function InviteFrame({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-page px-4 py-8">
      <div
        className="flex w-full animate-[gw-fade_.3s_ease] overflow-hidden"
        style={{
          maxWidth: 960,
          minHeight: 560,
          borderRadius: 18,
          border: "1px solid rgba(var(--gw-line-rgb),.09)",
          boxShadow: "0 18px 48px rgba(0,0,0,.34)",
          background: "var(--gw-panel-b)",
        }}
      >
        <InviteBrandPanel />
        <div className="flex min-w-0 flex-1 items-center justify-center" style={{ padding: 34 }}>
          <div className="w-full" style={{ maxWidth: 378 }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="flex items-center justify-between"
      style={{ gap: 16, padding: "11px 14px", borderTop: "1px solid rgba(var(--gw-line-rgb),.07)" }}
    >
      <span className="font-mono text-[11px] text-t8">{label}</span>
      <span className="min-w-0 truncate text-[13px] text-t3">{children}</span>
    </div>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function AcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { updateUser } = useAuth();

  const [state, setState] = useState<PageState>("loading");
  const [phase, setPhase] = useState<Phase>("accept");
  const [invite, setInvite] = useState<Invite | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.title = "Accept invite · Gatewerk";
  }, []);

  useEffect(() => {
    if (!token) {
      setState("invalid");
      return;
    }
    let cancelled = false;
    validateInviteToken(token)
      .then((data) => {
        if (cancelled) return;
        setInvite({
          email: data.email,
          role: data.role,
          inviter_name: data.inviter_name,
          team_name: data.team_name,
        });
        setState("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState(inviteStateFromError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (!name.trim()) {
      setError(C.nameRequired);
      return;
    }
    const check = checkPassword(password);
    if (!check.ok) {
      setError(check.reason === "long" ? C.tooLong : C.tooShort);
      return;
    }

    setLoading(true);
    try {
      const res = await acceptInvite(token!, { name: name.trim(), password });
      if (!res.token || !res.reviewer) {
        throw new Error(
          "Invite acceptance succeeded but the server response is missing a token or reviewer",
        );
      }
      // `false` for remember: accepting an invite is a one time act on a link,
      // not a considered choice to stay signed in on this device.
      setToken(res.token, false);
      updateUser(res.reviewer);
      // Show the handoff before leaving. The pause is the point — it names the
      // team they just joined and hands them to the inbox rather than dropping
      // them into one.
      setPhase("entering");
      setTimeout(() => navigate("/", { replace: true }), 1400);
    } catch (err) {
      setError(err instanceof Error ? err.message : C.failed);
      setLoading(false);
    }
  }

  if (state === "loading") {
    return (
      <InviteFrame>
        <div role="status" aria-label="Checking your invite" className="flex justify-center">
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              border: "2px solid rgba(var(--gw-line-rgb),.15)",
              borderTopColor: "var(--gw-t4)",
              animation: "spin 1s linear infinite",
            }}
          />
        </div>
      </InviteFrame>
    );
  }

  if (state !== "ready" || !invite) {
    const { title, body } = C.states[state === "ready" ? "error" : state];
    return (
      <InviteFrame>
        <div className="flex flex-col" style={{ gap: 16 }}>
          <div
            className="font-display text-[18px] font-semibold text-t1"
            style={{ letterSpacing: "-.01em" }}
          >
            {title}
          </div>
          <div
            className="flex items-start"
            style={{
              gap: 9,
              border: "1px solid rgba(var(--gw-red-rgb),.24)",
              background: "rgba(var(--gw-red-rgb),.09)",
              borderRadius: 11,
              padding: "10px 12px",
              fontSize: 12.5,
              color: "var(--gw-red-t)",
            }}
          >
            <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{body}</span>
          </div>
          {state === "used" && (
            <PrimaryBtn type="button" onClick={() => navigate("/login")}>
              {C.goToSignIn}
            </PrimaryBtn>
          )}
        </div>
      </InviteFrame>
    );
  }

  if (phase === "accept") {
    return (
      <InviteFrame>
        <div className="flex flex-col" style={{ gap: 22 }}>
          <div className="flex items-center" style={{ gap: 13 }}>
            {invite.inviter_name && (
              <span
                className="flex shrink-0 items-center justify-center font-mono text-[13px] font-semibold text-t3"
                style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--gw-avatar)" }}
                aria-hidden
              >
                {initialsOf(invite.inviter_name)}
              </span>
            )}
            <div className="flex min-w-0 flex-col" style={{ gap: 3 }}>
              <span className="text-[14px] font-semibold text-t1">
                {invite.inviter_name ? C.invitedBy(invite.inviter_name) : C.invitedByUnknown}
              </span>
              <span className="font-mono text-[11.5px] text-t8">
                {invite.team_name ? C.invitedTo(invite.team_name) : C.invitedToUnknown}
              </span>
            </div>
          </div>

          <div
            style={{
              borderRadius: 12,
              border: "1px solid rgba(var(--gw-line-rgb),.09)",
              background: "var(--gw-inset-soft)",
              overflow: "hidden",
            }}
          >
            {/* The first row's own top border is the card's, so it is suppressed. */}
            <div style={{ marginTop: -1 }}>
              {invite.team_name && <DetailRow label={C.teamLabel}>{invite.team_name}</DetailRow>}
              <DetailRow label={C.roleLabel}>
                <span
                  className="font-mono text-[10.5px] font-semibold uppercase tracking-[.08em]"
                  style={{
                    padding: "3px 8px",
                    borderRadius: 6,
                    border: "1px solid rgba(var(--gw-blue-rgb),.32)",
                    background: "rgba(var(--gw-blue-rgb),.10)",
                    color: "var(--gw-blue-t)",
                  }}
                >
                  {invite.role}
                </span>
              </DetailRow>
              <DetailRow label={C.emailLabel}>{invite.email}</DetailRow>
            </div>
          </div>

          <PrimaryBtn type="button" onClick={() => setPhase("name")}>
            {C.accept}
          </PrimaryBtn>

          <div className="text-center text-[12px] text-t8">
            {C.decline}{" "}
            <TextLink block={false} onClick={() => navigate("/login")}>
              <span style={{ color: "var(--gw-green-t)" }}>{C.declineAction}</span>
            </TextLink>
          </div>
        </div>
      </InviteFrame>
    );
  }

  if (phase === "name") {
    return (
      <InviteFrame>
        <div className="flex flex-col" style={{ gap: 18 }}>
          <div className="flex flex-col" style={{ gap: 7 }}>
            <span className="font-mono text-[10.5px] font-medium uppercase tracking-[.14em] text-t8">
              {C.nameEyebrow}
            </span>
            <h2
              className="font-display font-semibold text-t1"
              style={{ margin: 0, fontSize: 21, letterSpacing: "-.015em" }}
            >
              {C.nameTitle}
            </h2>
            <p className="text-[12.5px] text-t5" style={{ margin: 0, lineHeight: 1.5 }}>
              {C.nameBody}
            </p>
          </div>

          {error && <ErrorBanner>{error}</ErrorBanner>}

          <form onSubmit={handleSubmit} className="flex flex-col" style={{ gap: 16 }}>
            <div>
              <FieldLabel htmlFor="invite-name">{C.nameLabel}</FieldLabel>
              <FocusInput
                id="invite-name"
                type="text"
                required
                autoFocus
                autoComplete="name"
                placeholder={C.namePlaceholder}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div>
              <FieldLabel htmlFor="invite-password">{C.passwordLabel}</FieldLabel>
              <PasswordInput
                id="invite-password"
                required
                autoComplete="new-password"
                placeholder={C.passwordPlaceholder}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                visible={visible}
                onToggleVisible={() => setVisible(!visible)}
              />
            </div>

            <PrimaryBtn loading={loading} disabled={!name.trim() || !canSubmitPassword(password)}>
              {C.submit}
            </PrimaryBtn>
          </form>

          <TextLink onClick={() => setPhase("accept")}>← {C.back}</TextLink>
        </div>
      </InviteFrame>
    );
  }

  const firstName = name.trim().split(/\s+/)[0] || "there";
  return (
    <InviteFrame>
      <div className="flex flex-col items-center text-center" style={{ gap: 16 }}>
        <EmptyStateCore
          ring="live"
          tone="green"
          size={52}
          icon={<Check size={24} strokeWidth={2} />}
        />
        <div className="flex flex-col" style={{ gap: 6 }}>
          <div
            className="font-display text-[18px] font-semibold text-t1"
            style={{ letterSpacing: "-.01em" }}
          >
            {C.welcome(firstName)}
          </div>
          <div className="text-[12.5px] text-t5" style={{ lineHeight: 1.5 }}>
            {invite.team_name ? C.enteringBody(invite.team_name) : C.enteringBodyUnknown}
          </div>
        </div>
        <StatusPill variant="live" label={C.openingInbox} />
      </div>
    </InviteFrame>
  );
}

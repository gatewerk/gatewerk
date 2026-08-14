/**
 * Two-factor enrolment, hand-built (a bug here locks someone
 * out of the account that signs their approvals, so this file optimizes for
 * unlosable state over brevity).
 *
 * The wizard is ONE discriminated union. The codes view is the critical one:
 * backup codes exist on screen exactly once per generation, so Done stays
 * disabled until the user attests they saved them (copy + download +
 * save gate). Escape deliberately does NOT dismiss the codes
 * view — the only way out is the attested Done.
 *
 * Green appears exactly once per flow: the action that commits (Verify and
 * enable / Done). Enabled-state is a configuration fact and stays neutral.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  setup2FA,
  verifySetup2FA,
  disable2FA,
  regenerateBackupCodes,
  type TwoFactorSetupResponse,
} from "@gatewerk/web-core/api/two-factor";
import { downloadFile } from "@gatewerk/web-core/lib/utils";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import {
  CARD_STYLE,
  GhostButton,
  INSET_INPUT_CLASS,
  INSET_STYLE,
  PrimaryButton,
} from "../../templates/_ui";
import { CARD_SHELL } from "../_shared/ui";

type View =
  | { mode: "idle" }
  | { mode: "qr"; qr: TwoFactorSetupResponse }
  | { mode: "codes"; codes: string[] }
  | { mode: "confirm-disable" }
  | { mode: "confirm-regen" };

function assertNever(v: never): never {
  throw new Error(`unreachable 2fa view: ${JSON.stringify(v)}`);
}

/** Backup codes + the save gate. Done is the only exit and it is attested. */
function CodesPanel({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  function copyAll() {
    navigator.clipboard.writeText(codes.join("\n")).then(
      () => {
        setCopied(true);
        toast.success("Backup codes copied");
        setTimeout(() => setCopied(false), 2000);
      },
      () => toast.error("Failed to copy"),
    );
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-[11px] px-4 py-4"
      style={{ ...CARD_STYLE, border: "1px solid rgba(var(--gw-amber-rgb),.32)" }}
    >
      <p className="m-0 text-[12px]" style={{ color: "var(--gw-t5)" }}>
        Save these backup codes somewhere safe. Each code can only be used once.
      </p>
      <div className="grid grid-cols-2 gap-1.5 rounded-[10px] px-3 py-2.5" style={INSET_STYLE}>
        {codes.map((code) => (
          <span key={code} className="font-mono text-[13px] tracking-wider" style={{ color: "var(--gw-t2)" }}>
            {code}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <GhostButton onClick={copyAll} height={28}>
          {copied ? <Check size={12} strokeWidth={2} className="mr-1.5" /> : <Copy size={12} strokeWidth={1.9} className="mr-1.5" />}
          Copy all
        </GhostButton>
        <GhostButton
          onClick={() => downloadFile(codes.join("\n") + "\n", "gatewerk-backup-codes.txt", "text/plain")}
          height={28}
        >
          <Download size={12} strokeWidth={1.9} className="mr-1.5" />
          Download
        </GhostButton>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-[12px]" style={{ color: "var(--gw-t4)" }}>
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            style={{ accentColor: "var(--gw-t4)" }}
          />
          I have saved these codes
        </label>
        <PrimaryButton onClick={onDone} disabled={!saved} height={28}>
          Done
        </PrimaryButton>
      </div>
    </div>
  );
}

/** Password confirm for disable/regenerate. Escape cancels. */
function PasswordConfirm({
  description,
  actionLabel,
  isPending,
  onConfirm,
  onCancel,
}: {
  description: string;
  actionLabel: string;
  isPending: boolean;
  onConfirm: (password: string) => void;
  onCancel: () => void;
}) {
  const [pw, setPw] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="flex flex-col gap-3 rounded-[11px] px-4 py-4"
      style={{ ...CARD_STYLE, border: "1px solid rgba(var(--gw-red-rgb),.32)" }}
    >
      <p className="m-0 text-[12px]" style={{ color: "var(--gw-t5)" }}>
        {description}
      </p>
      <input
        type="password"
        autoComplete="current-password"
        autoFocus
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        placeholder="Current password"
        aria-label="Current password"
        className={`${INSET_INPUT_CLASS} w-64`}
        style={INSET_STYLE}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!pw || isPending}
          onClick={() => onConfirm(pw)}
          className="gw-focus-ring flex h-7 cursor-pointer items-center justify-center rounded-[7px] border-none px-4 text-[11.5px] font-semibold transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: "rgba(var(--gw-red-rgb),.16)", color: "var(--gw-red-t)" }}
        >
          {isPending && <Loader2 size={11} className="mr-1.5 animate-spin" />}
          {actionLabel}
        </button>
        <GhostButton onClick={onCancel} height={28}>
          Cancel
        </GhostButton>
      </div>
    </div>
  );
}

export function TwoFactorSection() {
  const { user, updateUser } = useAuth();
  const queryClient = useQueryClient();

  const [view, setView] = useState<View>({ mode: "idle" });
  const [verifyCode, setVerifyCode] = useState("");

  const is2faEnabled = !!user?.has_2fa;

  function onError(err: unknown) {
    toast.error(err instanceof Error ? err.message : "Request failed");
  }

  const setupMutation = useMutation({
    mutationFn: setup2FA,
    onSuccess: (data) => {
      setVerifyCode("");
      setView({ mode: "qr", qr: data });
    },
    onError,
  });

  const verifyMutation = useMutation({
    mutationFn: (code: string) => verifySetup2FA(code),
    onSuccess: (data) => {
      // Codes view FIRST, then the account flags — if anything below throws,
      // the codes are already the visible state and cannot be skipped past.
      setView({ mode: "codes", codes: data.backup_codes });
      if (user) updateUser({ ...user, has_2fa: true });
      void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      toast.success("Two-factor authentication enabled");
    },
    onError,
  });

  const disableMutation = useMutation({
    mutationFn: (password: string) => disable2FA(password),
    onSuccess: () => {
      setView({ mode: "idle" });
      if (user) updateUser({ ...user, has_2fa: false });
      void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      toast.success("Two-factor authentication disabled");
    },
    onError,
  });

  const regenMutation = useMutation({
    mutationFn: (password: string) => regenerateBackupCodes(password),
    onSuccess: (data) => {
      setView({ mode: "codes", codes: data.backup_codes });
      toast.success("Backup codes regenerated");
    },
    onError,
  });

  // Escape backs out of the QR step only. The codes view has no Escape exit on
  // purpose, and the password confirms handle their own.
  useEffect(() => {
    if (view.mode !== "qr") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setView({ mode: "idle" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.mode]);

  const headerRight =
    view.mode === "idle" && is2faEnabled ? (
      <div className="flex items-center gap-2">
        <GhostButton onClick={() => setView({ mode: "confirm-regen" })} height={26}>
          Regenerate codes
        </GhostButton>
        <GhostButton onClick={() => setView({ mode: "confirm-disable" })} tone="danger" height={26}>
          Disable
        </GhostButton>
      </div>
    ) : view.mode === "idle" ? (
      <GhostButton onClick={() => setupMutation.mutate()} disabled={setupMutation.isPending} height={26}>
        {setupMutation.isPending && <Loader2 size={11} className="mr-1.5 animate-spin" />}
        Enable
      </GhostButton>
    ) : undefined;

  return (
    <section style={CARD_SHELL}>
      <div className="flex items-center gap-3">
        <span className="flex-1 text-[14px] font-semibold" style={{ color: "var(--gw-t2)" }}>
          Two-factor authentication
        </span>
        {headerRight}
      </div>

      {view.mode === "idle" ? (
        <p className="mt-2.5 mb-0 text-[12.5px] leading-relaxed" style={{ color: "var(--gw-t7)" }}>
          {is2faEnabled
            ? "Your account is protected with two-factor authentication."
            : "Add an extra layer of security by requiring a code from your authenticator app when signing in."}
        </p>
      ) : view.mode === "qr" ? (
        <div className="mt-3 flex flex-col gap-4">
          <p className="m-0 text-[12px]" style={{ color: "var(--gw-t5)" }}>
            Scan this QR code with your authenticator app (e.g. Google Authenticator, Authy).
          </p>
          <div className="flex justify-center">
            <img
              src={view.qr.qr_data_url}
              alt="2FA QR code"
              className="rounded-[11px]"
              style={{ width: 180, height: 180, border: "1px solid rgba(var(--gw-line-rgb),.12)" }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <p className="m-0 text-[11px]" style={{ color: "var(--gw-t7)" }}>
              Or enter this secret manually:
            </p>
            <code
              className="block rounded-[10px] px-3 py-2 font-mono text-[12px] tracking-wider break-all"
              style={{ ...INSET_STYLE, color: "var(--gw-t2)" }}
            >
              {view.qr.base32}
            </code>
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-[12px] font-medium" style={{ color: "var(--gw-t6)" }}>
              Enter the 6-digit code to confirm setup
            </label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              aria-label="6-digit verification code"
              className={`${INSET_INPUT_CLASS} w-40 text-center font-mono tracking-widest`}
              style={INSET_STYLE}
            />
          </div>
          <div className="flex items-center gap-2">
            <PrimaryButton
              onClick={() => verifyMutation.mutate(verifyCode)}
              disabled={verifyCode.length < 6 || verifyMutation.isPending}
              height={28}
            >
              {verifyMutation.isPending && <Loader2 size={11} className="mr-1.5 animate-spin" />}
              Verify and enable
            </PrimaryButton>
            <GhostButton onClick={() => setView({ mode: "idle" })} height={28}>
              Cancel
            </GhostButton>
          </div>
        </div>
      ) : view.mode === "codes" ? (
        <div className="mt-3">
          <CodesPanel codes={view.codes} onDone={() => setView({ mode: "idle" })} />
        </div>
      ) : view.mode === "confirm-disable" ? (
        <div className="mt-3">
          <PasswordConfirm
            description="Enter your current password to disable two-factor authentication. This will make your account less secure."
            actionLabel="Disable 2FA"
            isPending={disableMutation.isPending}
            onConfirm={(pw) => disableMutation.mutate(pw)}
            onCancel={() => setView({ mode: "idle" })}
          />
        </div>
      ) : view.mode === "confirm-regen" ? (
        <div className="mt-3">
          <PasswordConfirm
            description="Enter your current password to regenerate backup codes. All existing backup codes will be invalidated."
            actionLabel="Regenerate"
            isPending={regenMutation.isPending}
            onConfirm={(pw) => regenMutation.mutate(pw)}
            onCancel={() => setView({ mode: "idle" })}
          />
        </div>
      ) : (
        assertNever(view)
      )}
    </section>
  );
}

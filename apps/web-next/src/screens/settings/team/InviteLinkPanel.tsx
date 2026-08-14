/**
 * The invite-link reveal — structurally RevealedKeyPanel's twin (same
 * amber "copy this now" card, same no-backdrop-close reasoning in
 * TeamPane's Modal). The link is a bearer credential (whoever holds it can
 * accept the invite as `email`) and is never re-displayed after this panel
 * closes, so it gets the same "shown once, copy now" treatment API keys
 * get.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { CARD_STYLE, GhostButton, IconButton, INSET_STYLE } from "../../templates/_ui";

export function InviteLinkPanel({
  inviteUrl,
  email,
  onDone,
}: {
  inviteUrl: string;
  email: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copyToClipboard() {
    navigator.clipboard.writeText(inviteUrl).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {
        toast.error("Failed to copy");
      },
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        className="flex flex-col gap-3 rounded-[11px] px-4 py-4"
        style={{
          ...CARD_STYLE,
          border: "1px solid rgba(var(--gw-amber-rgb),.32)",
        }}
      >
        <div className="flex items-center gap-2 rounded-[10px] px-3 py-2.5" style={INSET_STYLE}>
          <code className="min-w-0 flex-1 font-mono text-[12px] break-all" style={{ color: "var(--gw-t2)" }}>
            {inviteUrl}
          </code>
          <IconButton title={copied ? "Copied" : "Copy link"} onClick={copyToClipboard} size={26}>
            {copied ? (
              <Check size={13} strokeWidth={2} style={{ color: "var(--gw-green-t)" }} />
            ) : (
              <Copy size={13} strokeWidth={1.9} />
            )}
          </IconButton>
        </div>
        <p className="m-0 text-[11.5px]" style={{ color: "var(--gw-amber-t)" }}>
          Send this to {email} now. It expires in 7 days and won't be shown again here.
        </p>
      </div>

      <div className="flex justify-end">
        <GhostButton onClick={onDone}>Done</GhostButton>
      </div>
    </div>
  );
}

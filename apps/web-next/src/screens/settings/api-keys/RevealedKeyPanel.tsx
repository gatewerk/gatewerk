/**
 * The reveal-once panel. A raw key is on screen exactly once, right now —
 * which is the one configuration fact that IS live attention, so the card
 * carries the amber edge (FieldsSection's needs-options treatment: a
 * .32 amber border on CARD_STYLE).
 *
 * Nothing here auto-dismisses. The panel leaves only on an explicit Done,
 * Escape, or navigating away — and the copy button confirms in place, because
 * "did the copy actually land" is the entire job of this screen.
 *
 * Rendered inside ApiKeysPane's `Modal` with `closeOnBackdrop={false}`: a
 * stray click just outside the card is a much easier accident than a
 * deliberate Escape or Done, and unlike those two it was never part of this
 * panel's original exit list — the card had no "outside" to click before it
 * became an overlay.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { CARD_STYLE, GhostButton, IconButton, INSET_STYLE } from "../../templates/_ui";

export function RevealedKeyPanel({
  rawKey,
  name,
  onDone,
}: {
  rawKey: string;
  name: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copyToClipboard() {
    navigator.clipboard.writeText(rawKey).then(
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
        <div
          className="flex items-center gap-2 rounded-[10px] px-3 py-2.5"
          style={INSET_STYLE}
        >
          <code className="min-w-0 flex-1 font-mono text-[12px] break-all" style={{ color: "var(--gw-t2)" }}>
            {rawKey}
          </code>
          <IconButton title={copied ? "Copied" : "Copy key"} onClick={copyToClipboard} size={26}>
            {copied ? (
              <Check size={13} strokeWidth={2} style={{ color: "var(--gw-green-t)" }} />
            ) : (
              <Copy size={13} strokeWidth={1.9} />
            )}
          </IconButton>
        </div>
        <p className="m-0 text-[11.5px]" style={{ color: "var(--gw-amber-t)" }}>
          Copy this key now. It won't be shown again.
        </p>
      </div>

      <div className="flex justify-end">
        <GhostButton onClick={onDone}>Done</GhostButton>
      </div>
    </div>
  );
}

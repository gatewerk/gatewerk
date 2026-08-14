/**
 * Popover — the row-menu glass layer: fixed click-catcher underneath, an
 * absolutely positioned glass panel anchored below-right of the trigger,
 * Escape via the shared escape-layer stack. Escape ordering is handled by
 * the shared stack; if you ever need this inside a Modal, portal it the way
 * SelectMenu does (see screens/templates/_ui.tsx), because this panel is
 * position: absolute and would be clipped by Modal's overflowY: auto card.
 * Chrome lifted verbatim from WebhookRow's "..." menu, which itself copied
 * ApiKeyRow's; both now render this. The trigger button and its `relative`
 * wrapper stay at the call site — this component is only the floating layer.
 */
import { type ReactNode } from "react";
import { useEscapeLayer } from "./escape-layers";

export const POPOVER_ITEM_CLASS =
  "flex cursor-pointer items-center gap-2.5 rounded-[7px] border-none bg-transparent px-2.5 py-2 text-left text-[12.5px] transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)]";

export const POPOVER_ITEM_DANGER_CLASS =
  "flex cursor-pointer items-center gap-2.5 rounded-[7px] border-none bg-transparent px-2.5 py-2 text-left text-[12.5px] transition-colors hover:bg-[rgba(var(--gw-red-rgb),0.08)]";

export function Popover({
  open,
  onClose,
  width,
  children,
}: {
  open: boolean;
  onClose: () => void;
  width: number;
  children: ReactNode;
}) {
  useEscapeLayer(open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-[39]" onClick={onClose} />
      <div
        className="absolute right-0 z-[40] mt-1 flex flex-col gap-px p-1.5"
        style={{
          top: "100%",
          width,
          background: "rgba(var(--gw-modal-rgb),.96)",
          backdropFilter: "blur(18px) saturate(140%)",
          WebkitBackdropFilter: "blur(18px) saturate(140%)",
          border: "1px solid rgba(var(--gw-line-rgb),.14)",
          borderRadius: 11,
          boxShadow: "0 18px 44px rgba(0,0,0,.5), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
        }}
      >
        {children}
      </div>
    </>
  );
}

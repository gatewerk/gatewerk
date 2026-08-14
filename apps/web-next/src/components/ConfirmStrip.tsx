/**
 * ConfirmStrip — the in-menu destructive confirm: message + red confirm +
 * neutral cancel. Extracted verbatim from WebhookRow's confirm-delete
 * branch (itself copied from ApiKeyRow); those two now render this. It is
 * NOT a modal on purpose — the grammar keeps the confirm
 * where the destructive intent was expressed, inside the row's menu.
 */
interface ConfirmStripProps {
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmStrip({ message, confirmLabel = "Delete", onConfirm, onCancel }: ConfirmStripProps) {
  return (
    <div className="flex flex-col gap-2 px-2.5 py-2">
      <span className="text-[12px] leading-relaxed" style={{ color: "var(--gw-t5)" }}>
        {message}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="flex h-7 flex-1 cursor-pointer items-center justify-center rounded-[7px] border-none text-[11.5px] font-semibold transition-opacity hover:opacity-85"
          style={{ background: "rgba(var(--gw-red-rgb),.16)", color: "var(--gw-red-t)" }}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex h-7 flex-1 cursor-pointer items-center justify-center rounded-[7px] bg-transparent text-[11.5px] font-medium transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)]"
          style={{ border: "1px solid rgba(var(--gw-line-rgb),.12)", color: "var(--gw-t5)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

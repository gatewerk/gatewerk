/**
 * The phone's detail chrome: a back arrow, a title, and the pane below it.
 *
 * Every list plus detail screen uses this so back means the same thing
 * everywhere. onBack should change the URL rather than local state, so the
 * phone's own back gesture and this button agree. Escape also fires it, which
 * costs nothing on a phone and keeps a keyboard user consistent with the rest
 * of the app.
 */
import { useEffect } from "react";
import { ChevronLeft } from "lucide-react";

interface Props {
  title: string;
  onBack: () => void;
  children: React.ReactNode;
}

export function MobilePane({ title, onBack, children }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onBack();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div
        className="flex shrink-0 items-center gap-2"
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid rgba(var(--gw-line-rgb),.07)",
        }}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-[9px] border-none bg-transparent text-t6"
        >
          <ChevronLeft size={20} />
        </button>
        <span
          className="min-w-0 flex-1 truncate font-display text-t2"
          style={{ fontSize: 16, fontWeight: 600 }}
        >
          {title}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

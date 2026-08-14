import { type ReactNode } from "react";

/** 30x30 ghost icon button, the list-header and detail-header standard. Radius defaults to 8. */
export function IconButton({
  title,
  onClick,
  active = false,
  disabled = false,
  size = 30,
  radius = 8,
  "aria-haspopup": ariaHaspopup,
  "aria-expanded": ariaExpanded,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  size?: number;
  radius?: number;
  "aria-haspopup"?: "dialog" | "menu";
  "aria-expanded"?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-haspopup={ariaHaspopup}
      aria-expanded={ariaExpanded}
      disabled={disabled}
      onClick={onClick}
      className={
        active
          ? "gw-focus-ring relative flex shrink-0 cursor-pointer items-center justify-center border-none bg-[rgba(var(--gw-line-rgb),0.08)] text-t3 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          : "gw-focus-ring relative flex shrink-0 cursor-pointer items-center justify-center border-none bg-transparent text-t8 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)] hover:text-t4 disabled:cursor-not-allowed disabled:opacity-40"
      }
      style={{ width: size, height: size, borderRadius: radius }}
    >
      {children}
    </button>
  );
}

/** The green primary button used by Publish, Save chain and the modal's Add. */
export function PrimaryButton({
  children,
  onClick,
  disabled = false,
  title,
  height = 32,
  full = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  height?: number;
  full?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`gw-focus-ring flex cursor-pointer items-center justify-center rounded-[9px] border-none px-4 text-[12px] font-semibold transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${full ? "w-full" : ""}`}
      style={{ height, background: "var(--gw-green)", color: "var(--gw-green-ink)" }}
    >
      {children}
    </button>
  );
}

/** Outline counterpart to PrimaryButton. */
export function GhostButton({
  children,
  onClick,
  disabled = false,
  tone = "neutral",
  height = 32,
  full = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "neutral" | "danger";
  height?: number;
  full?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`gw-focus-ring flex cursor-pointer items-center justify-center rounded-[9px] bg-transparent px-4 text-[12px] font-medium transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)] disabled:cursor-not-allowed disabled:opacity-40 ${full ? "w-full" : ""}`}
      style={{
        height,
        border: "1px solid rgba(var(--gw-line-rgb),.12)",
        color: tone === "danger" ? "var(--gw-red-t)" : "var(--gw-t4)",
      }}
    >
      {children}
    </button>
  );
}

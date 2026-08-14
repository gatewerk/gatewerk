/**
 * One roster member, one flat hairline row — Team's list-row grammar.
 *
 * Unlike ApiKeyRow/WebhookRow (Toggle + overflow menu, several independent
 * actions), a Team row has exactly one action: Remove. Role editing is
 * deferred, so there is no Edit affordance and no menu to hold it —
 * by the settings-list convention, a single-primary-action row is
 * whole-row-clickable (hover tint + a trailing icon fading in on hover),
 * the same shape ActivityPane's expand-row and SettingsRow's onValueClick
 * already use. Remove is destructive, so the click opens an inline confirm
 * rather than firing immediately — same two-step shape ApiKeyRow/WebhookRow
 * use for their own destructive menu items, just without the menu wrapper.
 */
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { TeamMember } from "@gatewerk/web-core/api/notifications";
import { timeAgo } from "@gatewerk/web-core/lib/utils";
import { canRemoveMember, roleBadgeLabel } from "./team-logic";

interface TeamRowProps {
  member: TeamMember;
  currentUserId: string | undefined;
  onRemove: () => void;
}

export function TeamRow({ member, currentUserId, onRemove }: TeamRowProps) {
  const [confirming, setConfirming] = useState(false);
  const removable = canRemoveMember(member.id, currentUserId);

  useEffect(() => {
    if (!confirming) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setConfirming(false);
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [confirming]);

  const metaLine = [member.email, member.last_login_at ? `last login ${timeAgo(member.last_login_at)}` : null]
    .filter(Boolean)
    .join("  ");

  const rowContent = (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium" style={{ color: "var(--gw-t2)" }}>
            {member.name}
          </span>
          <span
            className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={
              member.role === "admin" || member.role === "owner"
                ? { background: "rgba(var(--gw-hi-rgb),.12)", color: "var(--gw-t3)" }
                : { border: "1px solid rgba(var(--gw-line-rgb),.16)", color: "var(--gw-t7)" }
            }
          >
            {roleBadgeLabel(member.role)}
          </span>
        </div>
        <span className="truncate font-mono text-[11px]" style={{ color: "var(--gw-t8)" }}>
          {metaLine}
        </span>
      </div>
      {removable && (
        <span
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: "var(--gw-t8)" }}
        >
          <Trash2 size={13} strokeWidth={1.9} />
        </span>
      )}
    </>
  );

  if (confirming) {
    return (
      <div
        className="flex items-center gap-3 px-2 py-2.5"
        style={{ borderBottom: "1px solid rgba(var(--gw-line-rgb),.06)" }}
      >
        <span className="min-w-0 flex-1 truncate text-[12px] leading-relaxed" style={{ color: "var(--gw-t5)" }}>
          {`Remove "${member.name}"? This cannot be undone.`}
        </span>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="flex h-7 cursor-pointer items-center rounded-[7px] border-none bg-transparent px-3 text-[11.5px] font-medium transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)]"
            style={{ border: "1px solid rgba(var(--gw-line-rgb),.12)", color: "var(--gw-t5)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              onRemove();
            }}
            className="flex h-7 cursor-pointer items-center rounded-[7px] border-none px-3 text-[11.5px] font-semibold transition-opacity hover:opacity-85"
            style={{ background: "rgba(var(--gw-red-rgb),.16)", color: "var(--gw-red-t)" }}
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  if (!removable) {
    return (
      <div
        className="flex items-center gap-3 rounded-[9px] px-2 py-2.5"
        style={{ borderBottom: "1px solid rgba(var(--gw-line-rgb),.06)" }}
      >
        {rowContent}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      aria-label={`Remove ${member.name}`}
      className="group gw-focus-ring flex w-full cursor-pointer items-center gap-3 rounded-[9px] border-none bg-transparent px-2 py-2.5 text-left transition-colors hover:bg-[rgba(var(--gw-red-rgb),0.05)]"
      style={{ borderBottom: "1px solid rgba(var(--gw-line-rgb),.06)" }}
    >
      {rowContent}
    </button>
  );
}

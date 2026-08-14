/**
 * One API key, one flat hairline row — the Redesign prototype's Keys row
 * grammar (manifest S4.6/S4.7), not a card. The meta line is lowercase mono,
 * space separated (the prototype's pipe separators lose to the standing
 * separator ruling — see _shared/ui.tsx). Expiry speaks only when it has
 * earned attention: amber inside seven days, red once past. A key that never
 * expires says nothing.
 *
 * Destructive actions live in the row's glass menu with the confirm INSIDE the
 * menu (DetailHeader's pattern) — rotate and delete both invalidate a secret
 * some agent is using, so both confirm in place.
 */
import { useState } from "react";
import { MoreHorizontal, Pencil, RotateCw, Send, Trash2 } from "lucide-react";
import type { ApiKey } from "@gatewerk/web-core/api/api-keys";
import { maskApiKey, timeAgo } from "@gatewerk/web-core/lib/utils";
import { ConfirmStrip } from "../../../components/ConfirmStrip";
import { Popover, POPOVER_ITEM_CLASS, POPOVER_ITEM_DANGER_CLASS } from "../../../components/Popover";
import { IconButton } from "../../templates/_ui";
import { Toggle } from "../_shared/Toggle";
import { detectPreset, daysUntil } from "./_forms";

type MenuState = "closed" | "open" | "confirm-rotate" | "confirm-delete";

interface ApiKeyRowProps {
  apiKey: ApiKey;
  onToggle: (is_active: boolean) => void;
  onTest: () => void;
  onEdit: () => void;
  onRotate: () => void;
  onDelete: () => void;
}

export function ApiKeyRow({ apiKey: c, onToggle, onTest, onEdit, onRotate, onDelete }: ApiKeyRowProps) {
  const [menu, setMenu] = useState<MenuState>("closed");

  const preset = detectPreset(c.scopes);
  const daysLeft = c.expires_at ? daysUntil(c.expires_at) : null;

  const meta: string[] = [preset, maskApiKey(c.key_prefix)];
  if (c.last_used_at) meta.push(`used ${timeAgo(c.last_used_at)}`);
  if (c.ip_allowlist && c.ip_allowlist.length > 0)
    meta.push(`${c.ip_allowlist.length} ip${c.ip_allowlist.length !== 1 ? "s" : ""}`);
  if (daysLeft !== null && daysLeft > 7) meta.push(`expires in ${daysLeft}d`);

  function confirmStyles(destructiveLabel: string, onConfirm: () => void, message: string) {
    return (
      <ConfirmStrip
        message={message}
        confirmLabel={destructiveLabel}
        onConfirm={() => {
          setMenu("closed");
          onConfirm();
        }}
        onCancel={() => setMenu("open")}
      />
    );
  }

  return (
    <div
      className="flex items-center gap-3 px-0.5 py-3"
      style={{ borderBottom: "1px solid rgba(var(--gw-line-rgb),.06)" }}
    >
      <div className={`flex min-w-0 flex-1 flex-col gap-0.5 ${c.is_active ? "" : "opacity-55"}`}>
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium" style={{ color: "var(--gw-t2)" }}>
            {c.name || "Unnamed"}
          </span>
          {daysLeft !== null && daysLeft < 0 && (
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ background: "rgba(var(--gw-red-rgb),.14)", color: "var(--gw-red-t)" }}
            >
              expired
            </span>
          )}
          {daysLeft !== null && daysLeft >= 0 && daysLeft <= 7 && (
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ background: "rgba(var(--gw-amber-rgb),.14)", color: "var(--gw-amber-t)" }}
            >
              {daysLeft === 0 ? "expires today" : `expires in ${daysLeft}d`}
            </span>
          )}
        </div>
        <span className="truncate font-mono text-[11px]" style={{ color: "var(--gw-t7)" }}>
          {meta.join("  ")}
        </span>
      </div>

      <Toggle
        checked={c.is_active}
        onChange={onToggle}
        aria-label={`${c.name || "API key"} active`}
      />

      <div className="relative shrink-0">
        <IconButton
          title="Key actions"
          active={menu !== "closed"}
          onClick={() => setMenu(menu === "closed" ? "open" : "closed")}
        >
          <MoreHorizontal size={15} strokeWidth={1.9} />
        </IconButton>

        <Popover open={menu !== "closed"} onClose={() => setMenu("closed")} width={232}>
          {menu === "confirm-rotate" ? (
            confirmStyles(
              "Rotate",
              onRotate,
              "This will invalidate the current key. Any agents using it will stop working.",
            )
          ) : menu === "confirm-delete" ? (
            confirmStyles(
              "Delete",
              onDelete,
              "This will permanently revoke this API key. Agents using it will lose access.",
            )
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setMenu("closed");
                  onTest();
                }}
                className={POPOVER_ITEM_CLASS}
                style={{ color: "var(--gw-t4)" }}
              >
                <Send size={13} strokeWidth={1.9} />
                Send test request
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenu("closed");
                  onEdit();
                }}
                className={POPOVER_ITEM_CLASS}
                style={{ color: "var(--gw-t4)" }}
              >
                <Pencil size={13} strokeWidth={1.9} />
                Edit
              </button>
              <button
                type="button"
                onClick={() => setMenu("confirm-rotate")}
                className={POPOVER_ITEM_CLASS}
                style={{ color: "var(--gw-t4)" }}
              >
                <RotateCw size={13} strokeWidth={1.9} />
                Rotate key
              </button>
              <button
                type="button"
                onClick={() => setMenu("confirm-delete")}
                className={POPOVER_ITEM_DANGER_CLASS}
                style={{ color: "var(--gw-red-t)" }}
              >
                <Trash2 size={13} strokeWidth={1.9} />
                Delete
              </button>
            </>
          )}
        </Popover>
      </div>
    </div>
  );
}

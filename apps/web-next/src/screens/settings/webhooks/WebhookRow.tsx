/**
 * One webhook, one flat hairline row — the prototype's Endpoints grammar
 * (manifest §2.5, S5.3): url line mono truncating, events meta line mono
 * dim, Toggle + overflow menu on the right. Not a card (ApiKeyRow's rounded
 * CARD_STYLE list is a different pane's grammar); this list reads as one
 * continuous rule-divided column, closer to SettingsRow's border-bottom.
 *
 * Destructive delete lives in the row's glass menu with the confirm INSIDE
 * the menu (ApiKeyRow's pattern, kept) — copy verbatim from apps/web's
 * ConfirmDialog: `Delete "{name}"? This cannot be undone.`
 */
import { useState } from "react";
import { MoreHorizontal, Pencil, Send, Trash2 } from "lucide-react";
import type { Webhook } from "@gatewerk/web-core/api/webhooks";
import { timeAgoShort } from "@gatewerk/web-core/lib/utils";
import { ConfirmStrip } from "../../../components/ConfirmStrip";
import { Popover, POPOVER_ITEM_CLASS, POPOVER_ITEM_DANGER_CLASS } from "../../../components/Popover";
import { IconButton } from "../../templates/_ui";
import { Toggle } from "../_shared/Toggle";
import { eventsMetaLine } from "./webhooks-logic";

type MenuState = "closed" | "open" | "confirm-delete";

interface WebhookRowProps {
  webhook: Webhook;
  onToggle: (is_active: boolean) => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function WebhookRow({ webhook: w, onToggle, onTest, onEdit, onDelete }: WebhookRowProps) {
  const [menu, setMenu] = useState<MenuState>("closed");

  return (
    <div
      className={`flex items-center gap-3 px-0.5 py-3 ${w.is_active ? "" : "opacity-55"}`}
      style={{ borderBottom: "1px solid rgba(var(--gw-line-rgb),.06)" }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-mono text-[12.5px]" style={{ color: "var(--gw-t3)" }}>
          {w.webhook_url}
        </span>
        <span className="truncate font-mono text-[11.5px]" style={{ color: "var(--gw-t8)" }}>
          {eventsMetaLine(w.events)}
        </span>
        {/* Only the failure case earns color — a healthy channel says nothing
            here (defaults render as silence), same as DeliveryRow's status
            badge rendering null for "delivered". last_delivery_at/status/
            error come from NotificationService's real dispatch path
            (services/notifications.ts), not the "Send test" button, which
            never writes these. */}
        {w.last_delivery_status === "failed" && (
          <span
            className="truncate font-mono text-[11px]"
            title={w.last_error ?? undefined}
            style={{ color: "var(--gw-red-t)" }}
          >
            Last delivery failed {w.last_delivery_at ? timeAgoShort(w.last_delivery_at) : ""}
            {w.last_error ? ` — ${w.last_error}` : ""}
          </span>
        )}
      </div>

      <Toggle checked={w.is_active} onChange={onToggle} aria-label={`${w.name || "Webhook"} active`} />

      <div className="relative shrink-0">
        <IconButton
          title="Webhook actions"
          active={menu !== "closed"}
          onClick={() => setMenu(menu === "closed" ? "open" : "closed")}
        >
          <MoreHorizontal size={15} strokeWidth={1.9} />
        </IconButton>

        <Popover open={menu !== "closed"} onClose={() => setMenu("closed")} width={216}>
          {menu === "confirm-delete" ? (
            <ConfirmStrip
              message={`Delete "${w.name}"? This cannot be undone.`}
              onConfirm={() => {
                setMenu("closed");
                onDelete();
              }}
              onCancel={() => setMenu("open")}
            />
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

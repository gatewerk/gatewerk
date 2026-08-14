/**
 * Pure form logic for the webhooks pane. Ported from
 * apps/web/src/pages/settings/project/webhooks/_options.ts rather than
 * imported: apps/web is frozen and every import into it is one more module
 * the eventual deletion has to unpick.
 */
import type {
  NotificationChannelType,
  WebhookCreateBodyInput,
  WebhookTestBodyInput,
  WebhookTestResponse,
  WebhookUpdateBody,
} from "@gatewerk/shared";
import type { Webhook } from "@gatewerk/web-core/api/webhooks";

/** Copy verbatim from apps/web's `_options.ts` — these are wire values plus
 * display labels, not prose, so the doctrine's "reuse reference copy" applies
 * without a rewrite. */
export const CHANNEL_TYPE_OPTIONS: Array<{
  value: NotificationChannelType;
  label: string;
  placeholder: string;
}> = [
  { value: "generic", label: "Generic JSON", placeholder: "https://your-endpoint.example/webhook" },
  { value: "slack", label: "Slack", placeholder: "https://hooks.slack.com/services/T.../B.../..." },
  { value: "discord", label: "Discord", placeholder: "https://discord.com/api/webhooks/.../..." },
  {
    value: "telegram",
    label: "Telegram",
    placeholder: "https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=...",
  },
];

/** Copy verbatim from apps/web's `_options.ts` (includes the HOTL monitoring
 * gate events from spec §4.9). */
export const AVAILABLE_EVENTS: Array<{ value: string; label: string }> = [
  { value: "review.created", label: "Review created" },
  { value: "review.urgent", label: "Review marked urgent" },
  { value: "review.assigned", label: "Review assigned" },
  { value: "review.decided", label: "Review decided" },
  { value: "review.expired", label: "Review expired" },
  { value: "review.retried", label: "Review retried" },
  { value: "review.assignment_escalated", label: "Assignment escalated" },
  { value: "review.action_taken", label: "Action taken" },
  { value: "review.sent_back", label: "Review sent back" },
  { value: "review.questions_raised", label: "Questions raised" },
  { value: "review.monitoring_created", label: "Monitoring gate opened" },
  { value: "review.vetoed", label: "Review vetoed" },
  { value: "review.confirmed", label: "Review confirmed" },
  { value: "review.veto_delivery_failed", label: "Veto delivery failed" },
  { value: "review.confirmed_delivery_failed", label: "Confirm delivery failed" },
];

export interface HeaderRow {
  key: string;
  value: string;
}

export interface WebhookFormData {
  name: string;
  webhookUrl: string;
  type: NotificationChannelType;
  events: string[];
  headers: HeaderRow[];
}

export function emptyWebhookForm(): WebhookFormData {
  return { name: "", webhookUrl: "", type: "generic", events: [], headers: [] };
}

export function webhookToForm(w: Webhook): WebhookFormData {
  const headers = w.headers ? Object.entries(w.headers).map(([key, value]) => ({ key, value })) : [];
  return {
    name: w.name,
    webhookUrl: w.webhook_url,
    type: (w.type ?? "generic") as NotificationChannelType,
    events: [...w.events],
    headers,
  };
}

export function channelPlaceholder(type: NotificationChannelType): string {
  return CHANNEL_TYPE_OPTIONS.find((o) => o.value === type)?.placeholder ?? "https://";
}

// Ported verbatim: rows with a blank key are dropped, and an all-blank list
// resolves to undefined (not `{}`) so create/update bodies can tell "no
// headers configured" apart from "headers explicitly cleared" (see
// formToUpdateBody, which nulls instead of omitting).
export function formToHeaders(rows: HeaderRow[]): Record<string, string> | undefined {
  const filtered = rows.filter((r) => r.key.trim());
  if (filtered.length === 0) return undefined;
  const obj: Record<string, string> = {};
  for (const r of filtered) obj[r.key.trim()] = r.value;
  return obj;
}

export function formToCreateBody(form: WebhookFormData): WebhookCreateBodyInput {
  return {
    name: form.name,
    webhook_url: form.webhookUrl,
    type: form.type,
    events: form.events,
    headers: formToHeaders(form.headers),
  };
}

// Update nulls a cleared header set rather than omitting it — an edit that
// removes the last header row means "stop sending these headers", and
// omitting the field would leave the server's stored headers untouched.
export function formToUpdateBody(form: WebhookFormData): WebhookUpdateBody {
  return {
    name: form.name,
    webhook_url: form.webhookUrl,
    type: form.type,
    events: form.events,
    headers: formToHeaders(form.headers) ?? null,
  };
}

export function formToTestBody(form: WebhookFormData): WebhookTestBodyInput {
  return {
    webhook_url: form.webhookUrl,
    type: form.type,
    headers: formToHeaders(form.headers),
  };
}

/**
 * Row meta line, the prototype's grammar (manifest §2.5, S5.3): lowercase
 * mono event names, space separated. The prototype's own copy reads
 * "review.decided · review.created · 3 more" — its middot separator and
 * "N more" suffix both lose to the standing rulings (space-separated meta
 * lines; "+N" rather than prose), so a five-event webhook reads
 * "review.decided review.created +3" here.
 */
export function eventsMetaLine(events: string[]): string {
  const shown = events.slice(0, 2).join(" ");
  const extra = events.length - 2;
  return extra > 0 ? `${shown} +${extra}` : shown;
}

export type TestToastOutcome = { kind: "success" | "error"; message: string };

/**
 * Copy verbatim from apps/web's `submitTest` handler. The failure branch
 * deliberately drops latency — a request that never reached the endpoint
 * (status 0) or bounced off it has nothing timing-related worth reporting.
 */
export function testToastMessage(r: WebhookTestResponse): TestToastOutcome {
  if (r.ok) {
    return { kind: "success", message: `Test sent · ${r.status} ${r.status_text} in ${r.latency_ms}ms` };
  }
  return {
    kind: "error",
    message: `Test failed · ${r.status === 0 ? r.status_text : `${r.status} ${r.status_text}`}`,
  };
}

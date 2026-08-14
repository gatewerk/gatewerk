import type { NotificationPayload, NotificationChannelType, Priority } from "@gatewerk/shared";

export interface TransformOptions {
  /** Absolute UI origin used to build click-through links (e.g. https://app.gatewerk.com). */
  uiOrigin: string;
}

/**
 * Format a NotificationPayload for the target channel type.
 *
 * - generic: `NotificationPayload` shape with `url` made absolute.
 * - slack: Block Kit (https://api.slack.com/block-kit) with a `text` fallback for
 *   the notification center / screen readers.
 * - discord: `{ content, embeds[] }` per
 *   https://discord.com/developers/docs/resources/webhook#execute-webhook.
 * - telegram: `sendMessage` body per https://core.telegram.org/bots/api#sendmessage.
 *   The `chat_id` is supplied via URL query string (the bot API reads query params
 *   natively), so the body carries `text` + `parse_mode: "MarkdownV2"` only and every
 *   interpolated value is escaped against MarkdownV2 reserved chars.
 *
 * Exhaustiveness is enforced via `assertNeverChannelType` — adding a value to
 * `NotificationChannelType` without wiring a transformer here is a compile error.
 */
export function transformPayload(
  type: NotificationChannelType,
  payload: NotificationPayload,
  options: TransformOptions,
): unknown {
  switch (type) {
    case "slack":
      return formatSlack(payload, options);
    case "discord":
      return formatDiscord(payload, options);
    case "telegram":
      return formatTelegram(payload, options);
    case "generic":
      return formatGeneric(payload, options);
    default:
      return assertNeverChannelType(type);
  }
}

function assertNeverChannelType(type: never): never {
  throw new Error(`[notification-payloads] Unhandled NotificationChannelType: ${String(type)}`);
}

function assertNeverPriority(priority: never): never {
  throw new Error(`[notification-payloads] Unhandled Priority: ${String(priority)}`);
}

/** Original wire shape, with `url` upgraded from relative to absolute. */
export function formatGeneric(payload: NotificationPayload, options: TransformOptions): NotificationPayload {
  return { ...payload, url: absoluteUrl(payload.url, options.uiOrigin) };
}

/**
 * Always include `text` alongside `blocks` — Slack uses it for notification-center
 * previews and screen readers, and recommends sending it even when blocks are present.
 */
export function formatSlack(payload: NotificationPayload, options: TransformOptions): unknown {
  const url = absoluteUrl(payload.url, options.uiOrigin);
  const title = humanizeEvent(payload.event);
  const fallback = `${title}: ${payload.template} (priority ${payload.priority})`;

  const button: Record<string, unknown> = {
    type: "button",
    text: { type: "plain_text", text: "Open in Gatewerk", emoji: true },
    url,
  };
  if (payload.priority === "critical" || payload.priority === "high") {
    button.style = "primary";
  }

  return {
    text: fallback,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: title, emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Template*\n${payload.template}` },
          { type: "mrkdwn", text: `*Priority*\n${payload.priority}` },
          { type: "mrkdwn", text: `*Review ID*\n\`${payload.review_id}\`` },
          { type: "mrkdwn", text: `*Project*\n${payload.project}` },
        ],
      },
      {
        type: "actions",
        elements: [button],
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `<!date^${Math.floor(new Date(payload.created_at).getTime() / 1000)}^Created {date_short_pretty} at {time}|${payload.created_at}>` },
        ],
      },
    ],
  };
}

/**
 * `content` is the short fallback and the only surface where `@mention` syntax
 * renders — Discord embeds silently strip mentions.
 */
export function formatDiscord(payload: NotificationPayload, options: TransformOptions): unknown {
  const url = absoluteUrl(payload.url, options.uiOrigin);
  const title = humanizeEvent(payload.event);

  return {
    content: `${title}: ${payload.template} (priority ${payload.priority})`,
    embeds: [
      {
        title,
        url,
        color: discordColorForPriority(payload.priority),
        fields: [
          { name: "Template", value: payload.template, inline: true },
          { name: "Priority", value: payload.priority, inline: true },
          { name: "Project", value: payload.project, inline: true },
          { name: "Review ID", value: `\`${payload.review_id}\``, inline: false },
        ],
        timestamp: payload.created_at,
      },
    ],
  };
}

function discordColorForPriority(priority: Priority): number {
  switch (priority) {
    case "critical":
      return 0xEF4444;
    case "high":
      return 0xEAB308;
    case "normal":
      return 0x22C55E;
    case "low":
      return 0x6B7280;
    default:
      return assertNeverPriority(priority);
  }
}

/**
 * Telegram Bot API `sendMessage` body. The `chat_id` is supplied via the webhook
 * URL query string (`?chat_id=<id>`), which the bot API reads transparently — so
 * the body carries text + parse_mode only.
 *
 * MarkdownV2 reserves `_*[]()~`>#+-=|{}.!` — every interpolated value is escaped to
 * keep the rendered message literal. The link URL is escaped separately against the
 * narrower `)` + `\` rule that applies inside `(...)`, and inline code spans use
 * the even-narrower `` ` `` + `\` rule.
 */
export function formatTelegram(payload: NotificationPayload, options: TransformOptions): unknown {
  const url = absoluteUrl(payload.url, options.uiOrigin);
  const title = humanizeEvent(payload.event);

  const text = [
    `*${escapeMarkdownV2(title)}*`,
    ``,
    `*Template:* ${escapeMarkdownV2(payload.template)}`,
    `*Priority:* ${escapeMarkdownV2(payload.priority)}`,
    `*Project:* ${escapeMarkdownV2(payload.project)}`,
    `*Review ID:* \`${escapeMarkdownV2Code(payload.review_id)}\``,
    ``,
    `[Open in Gatewerk](${escapeMarkdownV2LinkUrl(url)})`,
  ].join("\n");

  return {
    text,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true,
  };
}

/** Escape MarkdownV2 reserved chars in regular text. */
export function escapeMarkdownV2(input: string): string {
  return input.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

/** Escape inside an inline-code span: only `` ` `` and `\` need escaping. */
export function escapeMarkdownV2Code(input: string): string {
  return input.replace(/[`\\]/g, "\\$&");
}

/** Escape inside a link URL `(...)`: only `)` and `\` need escaping. */
export function escapeMarkdownV2LinkUrl(input: string): string {
  return input.replace(/[)\\]/g, "\\$&");
}

function absoluteUrl(maybeRelative: string, uiOrigin: string): string {
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  const base = uiOrigin.replace(/\/+$/, "");
  const path = maybeRelative.startsWith("/") ? maybeRelative : `/${maybeRelative}`;
  return `${base}${path}`;
}

function humanizeEvent(event: string): string {
  const dotIdx = event.indexOf(".");
  if (dotIdx === -1) return event;
  const head = event.slice(0, dotIdx);
  const tail = event.slice(dotIdx + 1).replace(/_/g, " ");
  return `${head.charAt(0).toUpperCase()}${head.slice(1)} ${tail}`;
}

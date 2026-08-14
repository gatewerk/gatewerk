/**
 * Block Kit message builder for Slack DM notifications.
 *
 * Produces a header + section + actions block payload that Slack renders
 * when the bot DMs a reviewer. No interactivity (action_id) is attached to
 * the button — clicking it opens the Gatewerk inbox in a browser tab.
 */

const HEADER_MAX = 150

export interface NotificationSlackMessagePayload {
  blocks: unknown[]
  text: string
}

// Fixed call to action for the body. The handler only has the notification
// title to work with (no summary or other payload field reaches this
// builder — see notification-slack-handler.ts:250), so the header keeps the
// title, the one informative line available, and the body adds a distinct
// prompt rather than repeating it verbatim.
const BODY_TEXT = 'Open your Gatewerk inbox to take a look.'

/**
 * Builds a Slack Block Kit message for a Gatewerk notification.
 *
 * @param title     - The notification title (truncated to 150 chars for Slack's header limit).
 * @param inboxUrl  - The Gatewerk inbox URL to open when the reviewer clicks the button.
 */
export function buildNotificationSlackMessage(
  title: string,
  inboxUrl: string,
): NotificationSlackMessagePayload {
  const headerText = title.length > HEADER_MAX ? title.slice(0, HEADER_MAX) : title

  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: headerText,
        emoji: false,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: BODY_TEXT,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Review in Gatewerk',
          },
          url: inboxUrl,
        },
      ],
    },
  ]

  return {
    blocks,
    text: `${title}. Review in Gatewerk`,
  }
}

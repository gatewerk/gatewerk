import { renderEmail, NotificationDigestEmail } from "@gatewerk/emails";
import { config } from "../../config";

export function renderNotificationDigestEmail({
  count,
  sampleTitles,
  unsubscribeUrl,
}: {
  count: number;
  sampleTitles: string[];
  unsubscribeUrl: string;
}) {
  return renderEmail(NotificationDigestEmail, {
    count,
    sampleTitles,
    inboxUrl: config.uiOrigin,
    unsubscribeUrl,
    logoUrl: config.emailLogoUrl,
  });
}

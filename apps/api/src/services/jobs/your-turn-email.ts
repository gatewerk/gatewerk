import { renderEmail, YourTurnEmail } from "@gatewerk/emails";
import { config } from "../../config";

/**
 * Deep-links to the specific review rather than the inbox root, matching the
 * link shape daily-digest already ships. apps/web (the app every compose file
 * actually builds) routes `reviews/:id` to a redirect onto `/?review=<id>`.
 *
 * `reviewId` is NULLABLE on the notifications row (packages/db/src/schema/
 * notifications.ts), so a notification with no review falls back to the inbox
 * root. Without the guard this would build a link to "/reviews/null".
 */
export function renderYourTurnEmail(title: string, reviewId: string | null) {
  // UI_ORIGIN is operator-supplied and may carry a trailing slash.
  const origin = config.uiOrigin.replace(/\/+$/, "");
  return renderEmail(YourTurnEmail, {
    title,
    reviewUrl: reviewId ? `${origin}/reviews/${reviewId}` : origin,
    logoUrl: config.emailLogoUrl,
  });
}

/**
 * Unsubscribe — public /unsubscribe confirmation page.
 *
 * Purely presentational. The API GET /api/v1/unsub/:token already flipped
 * the digest pref before 302-redirecting here with `?done=1`; this page does
 * no API call and handles no token. Without the marker (a direct visit, a
 * bookmark, a crawler) it shows a neutral explainer instead — it must never
 * claim "you are unsubscribed" when nothing was. The marker is trivially
 * forgeable, and that is fine: the page changes nothing either way, the
 * marker only keeps the copy honest for accidental arrivals.
 *
 * It reuses ReviewFrame (same public shell used by the external review page)
 * and mirrors the StatusTile visual structure with a neutral icon tile.
 *
 * Stage 3b Task 7. Spec §9.5 (one-click unsubscribe landing).
 */

import { Mail, MailX } from "lucide-react";
import { useSearchParams } from "react-router";
import { ReviewFrame } from "~/screens/review/ReviewFrame";

export function Unsubscribe() {
  const [params] = useSearchParams();
  const done = params.get("done") === "1";

  const Icon = done ? MailX : Mail;

  return (
    <ReviewFrame>
      <div
        className="flex flex-col items-center text-center"
        style={{ padding: "44px 0 30px" }}
      >
        {/* Icon tile — neutral tone, mirrors StatusTile elevation-only card */}
        <div
          className="flex items-center justify-center"
          style={{
            width: 56,
            height: 56,
            borderRadius: 18,
            marginBottom: 18,
            background: "rgba(var(--gw-line-rgb),.06)",
          }}
        >
          <Icon size={24} strokeWidth={1.9} color="var(--gw-t4)" />
        </div>

        <h1
          className="font-display text-t1"
          style={{ margin: 0, fontSize: 19, fontWeight: 600 }}
        >
          {done ? "You are unsubscribed" : "Email preferences"}
        </h1>

        <p
          style={{
            margin: "9px 0 0",
            maxWidth: 360,
            fontSize: 13,
            lineHeight: 1.6,
            color: "var(--gw-t5)",
          }}
        >
          {done
            ? "You will no longer receive Gatewerk digest emails. You can re-enable them anytime in Settings."
            : "This page confirms unsubscriptions from Gatewerk digest emails. Nothing has changed. To unsubscribe, use the link at the bottom of any digest email."}
        </p>
      </div>
    </ReviewFrame>
  );
}

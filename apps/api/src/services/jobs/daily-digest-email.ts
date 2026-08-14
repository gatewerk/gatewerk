import { renderEmail, DailyDigestEmail } from "@gatewerk/emails";
import { config } from "../../config";
import type { DailyDigestBatch } from "./daily-digest-predicate";

export async function renderDailyDigestEmail(batch: DailyDigestBatch) {
  return renderEmail(DailyDigestEmail, {
    count: batch.count,
    sampleReviewIds: batch.sample_review_ids,
    // UI_ORIGIN is operator-supplied and may carry a trailing slash, which
    // would build "//reviews/<id>". Normalized to match the sibling call in
    // your-turn-email.ts; two adjacent call sites disagreeing is the drift
    // that bites later.
    inboxUrl: config.uiOrigin.replace(/\/+$/, ""),
    logoUrl: config.emailLogoUrl,
  });
}

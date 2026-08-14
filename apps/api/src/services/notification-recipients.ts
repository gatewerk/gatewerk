import { eq } from "drizzle-orm";
import { reviewers } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";

export interface Recipient {
  reviewerId: string;
  email: string | null;
}

export async function resolveRecipients(
  db: AppDb,
  review: { assignee: string | null; id: string },
): Promise<Recipient[]> {
  const a = review.assignee;
  if (!a) return [];

  if (a.startsWith("role:")) {
    const role = a.slice("role:".length);
    const rows = await db
      .select()
      .from(reviewers)
      .where(eq(reviewers.role, role));
    return rows.map((r) => ({ reviewerId: r.id, email: r.email }));
  }

  // Try to look up by id (uuid or text id)
  const byId = await db
    .select()
    .from(reviewers)
    .where(eq(reviewers.id, a))
    .limit(1);
  if (byId[0]) return [{ reviewerId: byId[0].id, email: byId[0].email }];

  // Match a real reviewer by email before treating the value as an external
  // address. A chain owner is stored as "reviewer:<email>", so without this the
  // owner would get a ledger row keyed by their email rather than their id, and
  // their inbox would never show it.
  if (a.includes("@")) {
    const byEmail = await db
      .select()
      .from(reviewers)
      .where(eq(reviewers.email, a))
      .limit(1);
    if (byEmail[0]) return [{ reviewerId: byEmail[0].id, email: byEmail[0].email }];
  }

  // Raw email with no reviewer row → email-only recipient
  if (a.includes("@")) return [{ reviewerId: a, email: a }];

  // Unknown token (external_token or unrecognised) → no internal recipient.
  //
  // Returning empty for an `external_token` assignee is DELIBERATE, not a gap.
  // External reviewers are not internal humans with accounts, preferences or
  // Slack links, so there is nothing here to tap: they are reached by the
  // separate external-invite path, which emails a signed link to the address
  // pinned on the token. Resolving them here would either double-send or
  // create a ledger row for a person who has no inbox to read it in.
  //
  // The empty return is therefore correct, but it is also indistinguishable
  // from "assignee we failed to parse". If a future bug report says an
  // internal reviewer was never tapped, check the assignee shape here first:
  // silence at this line is the expected outcome for exactly one input and a
  // symptom for every other.
  return [];
}

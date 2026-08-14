import { sql, inArray, type SQL } from "drizzle-orm";
import { auditLog } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";

/**
 * Top-level keys in audit_log.details that carry a person's identity.
 *
 * Enumerated from every audit call site, not guessed. The scrub previously
 * removed only email, ip and user_agent, which missed the address key writers
 * actually use most often (`ip_address`, 26 call sites) and missed `name`,
 * which DELETE /account writes into its own account.deleted row.
 *
 * Slightly over-broad on purpose: `name` also labels an API key on some rows,
 * and losing that label is the cheaper mistake, because these keys are only
 * ever stripped from rows already established to belong to a deleted subject.
 */
const PERSONAL_DETAIL_KEYS = [
  "email",
  "name",
  "ip",
  "ip_address",
  "source_ip",
  "user_agent",
  "invitee_email",
  "removed_email",
  "submitted_email",
  "verified_email",
  "friendly_name",
  "to",
  "reviewer",
  "assignee",
] as const;

/**
 * Every distinct string this reviewer can appear as in audit_log.actor.
 *
 * The column is free-form text and call sites format it six different ways.
 * Anonymizing only the bare id left plaintext email addresses behind in an
 * append-only table with no purge:
 *
 *   <id>              most auth / account / passkey / session routes
 *   <email>           chain.completed and chain.rejected, which reuse
 *                     reviews.decided_by — documented as the raw
 *                     human-readable identifier, with no kind prefix
 *   reviewer:<email>  hold, monitoring, settings/team, settings/hmac, decide,
 *                     and everything else going through formatActor()
 *   reviewer:<id>     reviews/expired.ts, which falls back to the id when the
 *                     reviewer has no email
 *   user:<email>      api-keys/lifecycle.ts test-request rows
 *   user:<id>         token-reviews-account-tier.ts
 *
 * Matched by exact equality, never a LIKE prefix: `reviewer:a@b.com` cannot be
 * pattern-matched without also matching `reviewer:a@b.com.example`, and an
 * over-matching scrub would silently anonymize a different user's rows. The
 * remaining formats (`agent:`, `apikey:`, `api_key:`, `token:`, `external:`,
 * `system*`) identify keys, tokens and jobs rather than people.
 */
export function reviewerActorValues(reviewerId: string, email: string): string[] {
  const values = [
    reviewerId,
    email,
    `reviewer:${email}`,
    `reviewer:${reviewerId}`,
    `user:${email}`,
    `user:${reviewerId}`,
  ];
  // A blank id or email would collapse into a bare "reviewer:" or "user:",
  // which could match rows written with a missing identity.
  return [
    ...new Set(
      values.filter((v) => v.trim().length > 0 && v !== "reviewer:" && v !== "user:"),
    ),
  ];
}

function scrubbedDetails(): SQL {
  // jsonb `-` removes one key per application; the ::text cast keeps the bound
  // parameter from being ambiguous against the operator's other overloads.
  return PERSONAL_DETAIL_KEYS.reduce<SQL>(
    (acc, key) => sql`${acc} - ${key}::text`,
    sql`${auditLog.details}`,
  );
}

/**
 * Strips the personal fields from every audit_log row matched by `where` and
 * replaces `actor` with a tombstone value. Rows are updated in place, never
 * deleted: an audit trail that loses entries is worse than one holding
 * anonymized ones, and on an oversight product that is the whole point.
 *
 * This does break the row's HMAC signature chain, since actor and details are
 * both signature inputs. That was equally true of the narrower scrub it
 * replaces; it is called out here because it is not obvious from the call site.
 *
 * Used by apps/api/ee/jobs/data-cleanup.ts (Cloud org deletion, scoped by
 * project_id) and by DELETE /account via anonymizeAuditLogForReviewer below.
 */
export async function anonymizeAuditLogRows(db: AppDb, where: SQL): Promise<void> {
  await db
    .update(auditLog)
    .set({
      actor: "[deleted]",
      details: scrubbedDetails(),
    })
    .where(where);
}

/**
 * Anonymizes one reviewer's audit trail across every actor format they can
 * have been written as. Project-scoped anonymization does not subsume this:
 * auth and account rows are written with project_id null.
 */
export async function anonymizeAuditLogForReviewer(
  db: AppDb,
  reviewer: { id: string; email: string },
): Promise<void> {
  await anonymizeAuditLogRows(
    db,
    inArray(auditLog.actor, reviewerActorValues(reviewer.id, reviewer.email)),
  );
}

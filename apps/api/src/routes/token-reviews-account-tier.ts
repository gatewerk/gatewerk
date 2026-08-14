import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { reviewTokens } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import { GatewerkError } from "@gatewerk/shared";
import { tryReadMainAppSession, type SessionResult } from "../lib/auth-helpers";
import type { createAuditService } from "../services/audit";
import { resolveSenderHint } from "./token-reviews";

/**
 * Account-bound recipient flow handlers (token redesign §6.2 + edge case
 * E15). Extracted from routes/token-reviews.ts to keep that file under
 * the project's 600-line max-lines cap (CI-enforced via eslint max-lines). Page-internal — kept under
 * routes/ rather than promoted to services/ because both helpers operate
 * on Express req/res semantics, not domain logic.
 *
 * Identity strategy: reuse the main-app Bearer JWT from the Authorization
 * header — no new cookie, no new audience claim. The audience-negative-
 * match in lib/auth-helpers.validateJwt rejects recipient-session JWTs
 * (issued with aud:"token-recipient") so a cookie value forwarded into
 * Authorization cannot impersonate a main-app session (RFC 7519 §4.1.3).
 */

// Minimal token-record shape consumed here. Full row carries many more
// columns; we narrow to what these handlers actually read so a schema
// change to an unrelated column never widens the surface this file
// depends on.
interface AccountTierTokenRecord {
  id: string;
  review_id: string;
  project_id: string;
  auth_user_id: string | null;
  // Present only on GET-phase calls (handleAccountTierGet). Decide-phase
  // callers (handleAccountTierDecidePreflight) do not select these columns
  // and leave them undefined — which is safe because only handleAccountTierGet
  // uses them to build the sender_hint field.
  recipient_label?: string | null;
  created_by_kind?: string | null;
  created_by_id?: string | null;
}

type AuditService = ReturnType<typeof createAuditService>;

/**
 * GET branch for `auth_level: "account"` tokens. Three terminal cases:
 *
 * 1. No main-app session → emit audit + send `requires_account_login`
 *    response, return `{ kind: "responded" }`. Caller short-circuits.
 * 2. Logged-in identity does not match the token's `auth_user_id` (E15)
 *    → emit audit + send `account_mismatch` response, return
 *    `{ kind: "responded" }`. Recipient PII protection: only the current
 *    logged-in label is leaked; the bound recipient identity is kept
 *    server-side (audit row carries `expected_user_id` for ops).
 * 3. Identity matches → return `{ kind: "fall_through" }`. Caller
 *    continues to the standard review payload response.
 */
export async function handleAccountTierGet(
  req: Request,
  res: Response,
  db: AppDb,
  tokenRecord: AccountTierTokenRecord,
  auditService: AuditService | undefined,
): Promise<{ kind: "responded" } | { kind: "fall_through" }> {
  // Defense-in-depth: auth_level='account' requires non-null auth_user_id.
  // Migration 038 enforces this at the storage layer; this guard catches
  // any pre-038 rows that may exist (none in prod per the editor-UI gate
  // history) AND any future bypass (admin SQL, broken migration backfill).
  // Without it, `session.id !== null` always succeeds on a NULL row and
  // emits a misleading account_mismatch.
  if (!tokenRecord.auth_user_id) {
    if (auditService) {
      auditService.log({
        action: "token.account_mismatch",
        actor: "system",
        resource_type: "review",
        resource_id: tokenRecord.review_id,
        details: {
          reason: "auth_user_id_null_misconfiguration",
          token_id: tokenRecord.id,
          ip_address: req.ip ?? "unknown",
        },
        project_id: tokenRecord.project_id,
      }).catch(() => {});
    }
    res.status(500).json(
      new GatewerkError("This review link is misconfigured.", 500, "internal_error", "token_misconfigured").toJSON(),
    );
    return { kind: "responded" };
  }
  const session = await tryReadMainAppSession(req, db);
  if (!session) {
    if (auditService) {
      auditService.log({
        action: "token.account_login_redirect",
        actor: `token:${tokenRecord.id}`,
        resource_type: "review",
        resource_id: tokenRecord.review_id,
        details: { ip_address: req.ip ?? "unknown" },
        project_id: tokenRecord.project_id,
      }).catch(() => {});
    }
    res.json({
      status: "valid",
      requires_account_login: true,
      sender_hint: await resolveSenderHint(db, tokenRecord),
    });
    return { kind: "responded" };
  }
  if (session.id !== tokenRecord.auth_user_id) {
    if (auditService) {
      auditService.log({
        action: "token.account_mismatch",
        actor: `user:${session.id}`,
        resource_type: "review",
        resource_id: tokenRecord.review_id,
        details: {
          expected_user_id: tokenRecord.auth_user_id,
          actual_user_id: session.id,
          ip_address: req.ip ?? "unknown",
        },
        project_id: tokenRecord.project_id,
      }).catch(() => {});
    }
    // Spec §7 E15 — current_account_label only. expected_account_label
    // intentionally omitted: leaking the bound recipient identity to a
    // wrong-logged-in user is a recipient-PII disclosure regression.
    res.json({
      status: "valid",
      account_mismatch: true,
      current_account_label: session.email,
      sender_hint: await resolveSenderHint(db, tokenRecord),
    });
    return { kind: "responded" };
  }
  return { kind: "fall_through" };
}

/**
 * DECIDE-phase identity gate for account-tier tokens. Throws a typed
 * GatewerkError on missing or mismatched identity; returns the resolved
 * session on a clean match so the caller can stamp `decided_by_user_id`
 * post-consume. The mismatch audit fires here (decide phase) so ops can
 * separate read-only probes from decide attempts.
 */
export async function handleAccountTierDecidePreflight(
  req: Request,
  db: AppDb,
  tokenRecord: AccountTierTokenRecord,
  auditService: AuditService | undefined,
): Promise<SessionResult> {
  // Defense-in-depth: see handleAccountTierGet — same misconfiguration
  // guard. Throwing here keeps the decide-phase audit explicit (system
  // actor + auth_user_id_null_misconfiguration reason) and prevents the
  // wrong-identity comparison from emitting a misleading account_mismatch
  // on a malformed row.
  if (!tokenRecord.auth_user_id) {
    if (auditService) {
      auditService.log({
        action: "token.account_mismatch",
        actor: "system",
        resource_type: "review",
        resource_id: tokenRecord.review_id,
        details: {
          reason: "auth_user_id_null_misconfiguration",
          token_id: tokenRecord.id,
          phase: "decide",
          ip_address: req.ip ?? "unknown",
        },
        project_id: tokenRecord.project_id,
      }).catch(() => {});
    }
    throw new GatewerkError(
      "This review link is misconfigured.",
      500,
      "validation",
      "token_misconfigured",
    );
  }
  const session = await tryReadMainAppSession(req, db);
  if (!session) {
    throw new GatewerkError(
      "Please sign in to decide on this review.",
      401,
      "auth",
      "account_login_required",
    );
  }
  if (session.id !== tokenRecord.auth_user_id) {
    if (auditService) {
      auditService.log({
        action: "token.account_mismatch",
        actor: `user:${session.id}`,
        resource_type: "review",
        resource_id: tokenRecord.review_id,
        details: {
          expected_user_id: tokenRecord.auth_user_id,
          actual_user_id: session.id,
          phase: "decide",
          ip_address: req.ip ?? "unknown",
        },
        project_id: tokenRecord.project_id,
      }).catch(() => {});
    }
    throw new GatewerkError(
      "This link is not for your account.",
      401,
      "auth",
      "account_mismatch",
    );
  }
  return session;
}

/**
 * Post-consume forensic stamp + audit for an identity-verified
 * account-tier decide. Best-effort: stamp failure must not invalidate a
 * decision the recipient has already seen succeed at the action layer
 * (mirrors the email_otp `decided_by_email` pattern in the same file).
 */
export async function stampAccountTierDecided(
  req: Request,
  db: AppDb,
  tokenId: string,
  reviewId: string,
  projectId: string,
  session: SessionResult,
  auditService: AuditService | undefined,
): Promise<void> {
  let stamped = true;
  let stampError: unknown = null;
  try {
    await db
      .update(reviewTokens)
      .set({ decided_by_user_id: session.id })
      .where(eq(reviewTokens.id, tokenId));
  } catch (err) {
    stamped = false;
    stampError = err;
    console.error("[account-tier] decided_by_user_id stamp failed", err);
  }
  if (auditService) {
    // Stamp failure must surface in the audit trail with stamp_failed:true
    // so forensic reconstruction does not assert decided_by_user_id is on
    // the row when the UPDATE rejected. Same audit action shape; details
    // discriminator lets ops queries filter for failed forensic stamps.
    if (stamped) {
      auditService.log({
        action: "token.account_decided",
        actor: `user:${session.id}`,
        resource_type: "review",
        resource_id: reviewId,
        details: {
          decided_by_user_id: session.id,
          decided_by_email: session.email,
          ip_address: req.ip ?? "unknown",
        },
        project_id: projectId,
      }).catch(() => {});
    } else {
      auditService.log({
        action: "token.account_decided",
        actor: `user:${session.id}`,
        resource_type: "review",
        resource_id: reviewId,
        details: {
          stamp_failed: true,
          error_message:
            stampError instanceof Error ? stampError.message : String(stampError),
          decided_by_user_id: session.id,
          decided_by_email: session.email,
          ip_address: req.ip ?? "unknown",
        },
        project_id: projectId,
      }).catch(() => {});
    }
  }
}

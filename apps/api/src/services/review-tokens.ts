import { eq, and, isNull, desc, sql, gt } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { reviewTokens, reviews, templates } from "@gatewerk/db/src/schema/index";
import {
  generateId,
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  type TokenHistoryRow,
  type ListReviewTokensResponse,
} from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";

const DEFAULT_EXPIRY_HOURS = 48;

export type GenerateTokenInput = {
  review_id: string;
  project_id: string;
  purpose: string;
  recipient_label: string;
  note?: string | null;
  auth_level?: "public" | "email_otp" | "account";
  auth_email?: string | null;
  auth_user_id?: string | null;
  created_by_kind: "manual" | "chain" | "agent";
  created_by_id: string;
  expiryHours?: number;
  is_preview?: boolean;
};

export type RevokeTokenInput = {
  review_id: string;
  revoked_by: string;
  reason?: string | null;
};

export type RevokeTokenResult =
  | { success: true; revokedTokenId: string; reason: string | null }
  | { success: false; error: "no_active_token" };

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function generateRawToken(): string {
  const random = randomBytes(32).toString("hex");
  return `gw_tok_${random}`;
}

// Token-history-panel (spec §8.3). Status precedence revoked > used >
// expired > active. The revoke→consume race may stamp both revoked_at and
// used_at on the same row; revoked dominates as the terminal lifecycle
// state so the operator's intent (revoke) is what surfaces in the UI.
//
// Exported for the chain envelope projection (§13) so the chain timeline
// UI shows uniform token lifecycle badges without duplicating the
// precedence logic. Single source of truth.
export function deriveTokenStatus(
  row: typeof reviewTokens.$inferSelect,
): TokenHistoryRow["status"] {
  if (row.revoked_at !== null) return "revoked";
  if (row.used_at !== null) {
    switch (row.decision) {
      case "approved":
        return "approved";
      case "rejected":
        return "rejected";
      case "declined":
        return "declined";
      default:
        // Forward-compat for configurable-actions decision labels (spec §11.2)
        // — any non-canonical decision rolls up to a generic completed badge.
        return "completed";
    }
  }
  if (row.expires_at.getTime() <= Date.now()) return "expired";
  return "active";
}

function toTokenHistoryRow(
  row: typeof reviewTokens.$inferSelect,
): TokenHistoryRow {
  return {
    id: row.id,
    recipient_label: row.recipient_label,
    auth_level: row.auth_level as TokenHistoryRow["auth_level"],
    purpose: row.purpose,
    note: row.note,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    used_at: row.used_at ? row.used_at.toISOString() : null,
    revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
    revoked_by: row.revoked_by,
    opened_at: row.opened_at ? row.opened_at.toISOString() : null,
    decided_by_email: row.decided_by_email,
    decided_by_user_id: row.decided_by_user_id,
    decision: row.decision,
    status: deriveTokenStatus(row),
  };
}

// Cross-field auth-tier invariant gate (§13). Helper-layer
// defense-in-depth. Catches future code paths that bypass the wire schema
// (raw service calls in tests, future bulk endpoints, agent SDK callers,
// drift if the chain wire schema is ever bypassed). Same five stable
// error codes as the manual route schema and the chain wire schema in
// packages/shared/src/api/schemas/chains.ts so SDK callers can branch on
// `code` uniformly across all entry paths.
//
// 5th preventive member of the project-level invariant-pair-mutation
// family — enforces the (auth_level, auth_email, auth_user_id) tuple at
// THREE layers (manual wire schema + chain wire schema + this helper).
function assertAuthTierInvariant(input: GenerateTokenInput): void {
  const auth_level = input.auth_level ?? "public";
  const auth_email = input.auth_email ?? null;
  const auth_user_id = input.auth_user_id ?? null;

  if (auth_level === "public" && auth_email) {
    throw new InvalidRequestError(
      "auth_email must be null when auth_level is public",
      "auth_email",
      "auth_level.contextual_fields_not_allowed_for_public",
    );
  }
  if (auth_level === "public" && auth_user_id) {
    throw new InvalidRequestError(
      "auth_user_id must be null when auth_level is public",
      "auth_user_id",
      "auth_level.contextual_fields_not_allowed_for_public",
    );
  }
  if (auth_level === "email_otp" && !auth_email) {
    throw new InvalidRequestError(
      "auth_email required when auth_level is email_otp",
      "auth_email",
      "auth_level.email_required",
    );
  }
  if (auth_level === "email_otp" && auth_user_id) {
    throw new InvalidRequestError(
      "auth_user_id must be null when auth_level is email_otp",
      "auth_user_id",
      "auth_level.user_id_not_allowed_for_email_otp",
    );
  }
  if (auth_level === "account" && !auth_user_id) {
    throw new InvalidRequestError(
      "auth_user_id required when auth_level is account",
      "auth_user_id",
      "auth_level.user_id_required",
    );
  }
  if (auth_level === "account" && auth_email) {
    throw new InvalidRequestError(
      "auth_email must be null when auth_level is account",
      "auth_email",
      "auth_level.email_not_allowed_for_account",
    );
  }
}

export function createReviewTokenService(db: AppDb) {
  return {
    async generate(input: GenerateTokenInput) {
      // Helper-layer cross-field invariant gate — see assertAuthTierInvariant
      // comment block. MUST run before the txn opens so a violation fails
      // fast with a 400 rather than holding a row lock for an aborted
      // transaction.
      assertAuthTierInvariant(input);

      const rawToken = generateRawToken();
      const tokenHash = hashToken(rawToken);
      const PREVIEW_TTL_MINUTES = 5;
      const expiryHours = input.is_preview
        ? PREVIEW_TTL_MINUTES / 60
        : (input.expiryHours ?? DEFAULT_EXPIRY_HOURS);
      const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

      // Token-redesign Phase 1 (spec §4.2): generate is now an atomic
      // pending → awaiting_external transition. The SELECT FOR UPDATE row
      // lock serializes the transition — two parallel generate calls on the
      // same review block on the lock; whichever lands second sees the row
      // as awaiting_external and throws ConflictError, ensuring only one
      // active token exists per review at any moment.
      return await db.transaction(async (tx) => {
        const [review] = await tx
          .select()
          .from(reviews)
          .where(eq(reviews.id, input.review_id))
          .for("update")
          .limit(1);

        if (!review) {
          throw new NotFoundError("Review not found", "review_not_found");
        }

        if (review.status === "monitoring") {
          // Deliberate FORBID (spec §4.7): the external page would render a
          // fake please-approve card for an already-executed action, and the
          // status flip to awaiting_external would disarm the veto worker.
          throw new ConflictError(
            "Monitoring reviews cannot be shared with external recipients.",
            "monitoring_not_shareable",
          );
        }

        if (review.status !== "pending") {
          // Preview tokens are exempt from awaiting_external: they never
          // transition the review (skip below), cannot act (token_is_preview
          // guard on the action route), and are excluded from every
          // active-token selection (is_preview = false filters) — so the
          // one-active-token invariant is untouched. This is what powers
          // the Manage-modal / rail-card "Preview" on a live link.
          const previewFromExternal =
            (input.is_preview ?? false) && review.status === "awaiting_external";
          if (!previewFromExternal) {
            throw new ConflictError(
              "Cannot generate token for a review that is not pending",
              "review_not_pending",
            );
          }
        }

        const [tokenRecord] = await tx.insert(reviewTokens).values({
          id: generateId("token"),
          token_hash: tokenHash,
          review_id: input.review_id,
          project_id: input.project_id,
          expires_at: expiresAt,
          purpose: input.purpose,
          recipient_label: input.recipient_label,
          note: input.note ?? null,
          auth_level: input.auth_level ?? "public",
          auth_email: input.auth_email ?? null,
          auth_user_id: input.auth_user_id ?? null,
          created_by_kind: input.created_by_kind,
          created_by_id: input.created_by_id,
          is_preview: input.is_preview ?? false,
        }).returning();

        if (!input.is_preview) {
          await tx
            .update(reviews)
            .set({ status: "awaiting_external", updated_at: new Date() })
            .where(eq(reviews.id, input.review_id));
        }

        return { rawToken, tokenRecord };
      });
    },

    async revoke(input: RevokeTokenInput): Promise<RevokeTokenResult> {
      // Token-redesign Phase 1 (spec §4.4): revoke marks the active token
      // revoked + reverts the review to pending atomically. Reason is captured
      // in the audit emission only, not stored on the token row, per spec §9
      // (reason lives in audit details to keep the table lean and align with
      // the DocuSign void pattern).
      return await db.transaction(async (tx) => {
        const activeTokens = await tx
          .select()
          .from(reviewTokens)
          .where(
            and(
              eq(reviewTokens.review_id, input.review_id),
              isNull(reviewTokens.used_at),
              isNull(reviewTokens.revoked_at),
              eq(reviewTokens.is_preview, false),
              gt(reviewTokens.expires_at, new Date()),
            ),
          )
          .orderBy(desc(reviewTokens.created_at))
          .for("update")
          .limit(1);

        if (activeTokens.length === 0) {
          return { success: false as const, error: "no_active_token" as const };
        }

        const target = activeTokens[0];

        await tx
          .update(reviewTokens)
          .set({ revoked_at: new Date(), revoked_by: input.revoked_by })
          .where(eq(reviewTokens.id, target.id));

        await tx
          .update(reviews)
          .set({ status: "pending", updated_at: new Date() })
          .where(eq(reviews.id, input.review_id));

        return {
          success: true as const,
          revokedTokenId: target.id,
          reason: input.reason ?? null,
        };
      });
    },

    async extend(input: {
      review_id: string;
      hours: number;
    }): Promise<
      | { success: true; tokenId: string; expires_at: Date }
      | { success: false; error: "no_active_token" }
    > {
      // Share-modal manage mode: push the active token's expiry out by N
      // hours. Same active-token selection as revoke() — extending a used,
      // revoked, expired, or preview token is not allowed (an expired link
      // must be re-generated, never resurrected).
      return await db.transaction(async (tx) => {
        const activeTokens = await tx
          .select()
          .from(reviewTokens)
          .where(
            and(
              eq(reviewTokens.review_id, input.review_id),
              isNull(reviewTokens.used_at),
              isNull(reviewTokens.revoked_at),
              eq(reviewTokens.is_preview, false),
              gt(reviewTokens.expires_at, new Date()),
            ),
          )
          .orderBy(desc(reviewTokens.created_at))
          .for("update")
          .limit(1);

        if (activeTokens.length === 0) {
          return { success: false as const, error: "no_active_token" as const };
        }

        const target = activeTokens[0];
        const newExpiry = new Date(
          target.expires_at.getTime() + input.hours * 3_600_000,
        );

        await tx
          .update(reviewTokens)
          .set({ expires_at: newExpiry })
          .where(eq(reviewTokens.id, target.id));

        return {
          success: true as const,
          tokenId: target.id,
          expires_at: newExpiry,
        };
      });
    },

    async validate(rawToken: string) {
      const tokenHash = hashToken(rawToken);

      const [tokenRecord] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.token_hash, tokenHash))
        .limit(1);

      if (!tokenRecord) {
        return null;
      }

      // Look up the review
      const [review] = await db
        .select()
        .from(reviews)
        .where(eq(reviews.id, tokenRecord.review_id))
        .limit(1);

      if (!review) {
        return null;
      }

      // Look up the template for field metadata. Reviews without a template
      // (legacy or ad-hoc) are still valid — token validation should not fail
      // just because there's no schema to fetch.
      const [template] = review.template_id
        ? await db.select().from(templates).where(eq(templates.id, review.template_id)).limit(1)
        : [undefined];

      // Revoked tokens must NEVER surface as valid. The operator reverted
      // the review back to pending when calling revoke(); the recipient may
      // still hold the raw URL but the token row is dead. Surfaces as a
      // distinct `revoked` status so the UI can render a terminal "this
      // link has been revoked" page rather than the review payload.
      if (tokenRecord.revoked_at) {
        return {
          status: "revoked" as const,
          tokenRecord,
          review,
          template: template || null,
        };
      }

      // Check if already used
      if (tokenRecord.used_at) {
        return {
          status: "used" as const,
          tokenRecord,
          review,
          template: template || null,
        };
      }

      // Check expiry
      if (new Date(tokenRecord.expires_at) <= new Date()) {
        return {
          status: "expired" as const,
          tokenRecord,
          review,
          template: template || null,
        };
      }

      // Check if review is still in an active token-holding state. Tokens
      // issued post-C4 land the review in 'awaiting_external'; legacy tokens
      // issued pre-C4 may still see 'pending' (backward compat). Any other
      // status (decided / awaiting_iteration / expired / archived) means the
      // review has moved on and the token is effectively spent.
      if (review.status !== "pending" && review.status !== "awaiting_external") {
        return {
          status: "used" as const,
          tokenRecord,
          review,
          template: template || null,
        };
      }

      return {
        status: "valid" as const,
        tokenRecord,
        review,
        template: template || null,
      };
    },

    async consume(
      rawToken: string,
      data: {
        decision: string;
        ip_address: string;
        user_agent: string;
        feedback?: string;
      },
    ) {
      const tokenHash = hashToken(rawToken);

      return await db.transaction(async (tx) => {
        const [tokenRecord] = await tx
          .select()
          .from(reviewTokens)
          .where(eq(reviewTokens.token_hash, tokenHash))
          .for("update")
          .limit(1);

        if (!tokenRecord) {
          return { success: false as const, error: "invalid" as const };
        }

        // Operator-initiated revocation takes precedence over all other
        // states (used / expired). Matches the audit error_priority ordering
        // at the top of this file: revoked > used > expired > active.
        if (tokenRecord.revoked_at) {
          return { success: false as const, error: "revoked" as const };
        }

        if (tokenRecord.used_at) {
          return { success: false as const, error: "already_used" as const };
        }

        if (new Date(tokenRecord.expires_at) <= new Date()) {
          return { success: false as const, error: "expired" as const };
        }

        // Mark token as consumed
        const [updated] = await tx
          .update(reviewTokens)
          .set({
            used_at: new Date(),
            decision: data.decision,
            ip_address: data.ip_address,
            user_agent: data.user_agent,
          })
          .where(eq(reviewTokens.token_hash, tokenHash))
          .returning();

        if (!updated || updated.used_at === null) {
          return { success: false as const, error: "already_used" as const };
        }

        return {
          success: true as const,
          tokenRecord: updated,
        };
      });
    },

    /**
     * Consume a token for a recipient action that does NOT carry a decision
     * — Decline (spec §7 E3) and Send-questions (§7 E4). Mirrors `consume`
     * but: (a) leaves `decision` NULL, (b) reverts the review to `pending`
     * inside the same transaction so the (token.used_at, review.status)
     * invariant pair cannot drift on partial failure, (c) accepts an
     * optional forensic stamp (decided_by_email or decided_by_user_id)
     * applied per tier by the route handler, (d) optionally inserts a
     * recipient-authored note inside the same transaction so the (token,
     * review.status, note) tuple is fully atomic for raise-questions where
     * the note carries the recipient's verbatim text.
     *
     * Kept separate from `consume` because that signature has `decision`
     * baked in for the SDK + chain-engine callers; widening it to a
     * discriminated union would ripple across consumers that have no
     * recipient-action surface.
     *
     * Returns `{ error: 'review_already_decided' }` when a concurrent
     * main-app reviewer has moved the review to `decided` between the
     * caller's validate() pass and this txn — the row lock on `reviews`
     * serializes against the /decide handler so we cannot silently
     * overwrite a legitimate decision.
     */
    async consumeAsRecipientAction(
      rawToken: string,
      data: {
        kind: "declined" | "questions_raised";
        ip_address: string;
        user_agent: string;
        decided_by_email?: string | null;
        decided_by_user_id?: string | null;
        /**
         * Optional note insert inside the same transaction. The callback
         * receives the freshly-updated token row and runs against the
         * txn's tx handle. A throw here rolls back the entire consume.
         */
        insertNote?: (
          tx: Parameters<Parameters<AppDb["transaction"]>[0]>[0],
          tokenRow: typeof reviewTokens.$inferSelect,
        ) => Promise<void>;
      },
    ) {
      const tokenHash = hashToken(rawToken);

      return await db.transaction(async (tx) => {
        const [tokenRecord] = await tx
          .select()
          .from(reviewTokens)
          .where(eq(reviewTokens.token_hash, tokenHash))
          .for("update")
          .limit(1);

        if (!tokenRecord) {
          return { success: false as const, error: "invalid" as const };
        }

        if (tokenRecord.used_at) {
          return { success: false as const, error: "already_used" as const };
        }

        if (new Date(tokenRecord.expires_at) <= new Date()) {
          return { success: false as const, error: "expired" as const };
        }

        if (tokenRecord.revoked_at) {
          return { success: false as const, error: "invalid" as const };
        }

        // TOCTOU defense — explicit row lock on the review serializes
        // against /decide's outer-txn lock. Without this, a main-app
        // reviewer could decide the review between the caller's validate()
        // pass and this consume, and the unconditional revert below would
        // silently overwrite the decision. Same invariant-pair-mutation
        // family as PR #15..#17. See spec §7 + project memory for context.
        const [reviewRow] = await tx
          .select({ status: reviews.status, current_version: reviews.current_version })
          .from(reviews)
          .where(eq(reviews.id, tokenRecord.review_id))
          .for("update")
          .limit(1);

        if (!reviewRow) {
          return { success: false as const, error: "invalid" as const };
        }

        if (
          reviewRow.status !== "awaiting_external" &&
          reviewRow.status !== "pending"
        ) {
          return {
            success: false as const,
            error: "review_already_decided" as const,
          };
        }

        // Stamp the consume + forensic fields on the token row. decision
        // stays NULL by spec §7 — Decline and Send-questions are not
        // decisions; they revert the review for the reviewer to act again.
        const [updated] = await tx
          .update(reviewTokens)
          .set({
            used_at: new Date(),
            ip_address: data.ip_address,
            user_agent: data.user_agent,
            decided_by_email: data.decided_by_email ?? null,
            decided_by_user_id: data.decided_by_user_id ?? null,
          })
          .where(eq(reviewTokens.token_hash, tokenHash))
          .returning();

        if (!updated || updated.used_at === null) {
          return { success: false as const, error: "already_used" as const };
        }

        // Scoped revert — current_version bump preserves the optimistic
        // concurrency invariant SSE consumers depend on. Status filter is
        // belt-and-braces against the row lock above (in case the lock
        // semantics drift on a future PG upgrade).
        const [revertedReview] = await tx
          .update(reviews)
          .set({
            status: "pending",
            updated_at: new Date(),
            current_version: reviewRow.current_version + 1,
          })
          .where(
            and(
              eq(reviews.id, tokenRecord.review_id),
              eq(reviews.status, reviewRow.status),
            ),
          )
          .returning();

        if (!revertedReview) {
          return {
            success: false as const,
            error: "review_already_decided" as const,
          };
        }

        // Atomic note insert — for raise-questions the note carries the
        // recipient's verbatim text and a silent drop is functional
        // regression. A throw here rolls the txn back including the
        // token consume, so the recipient sees a clear error instead of
        // a half-applied state.
        if (data.insertNote) {
          await data.insertNote(tx, updated);
        }

        return {
          success: true as const,
          tokenRecord: updated,
          reviewRecord: revertedReview,
        };
      });
    },

    async listTokensForReview(
      projectId: string,
      reviewId: string,
      opts: { limit?: number; offset?: number } = {},
    ): Promise<ListReviewTokensResponse> {
      const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
      const offset = Math.max(opts.offset ?? 0, 0);

      const [review] = await db
        .select({ id: reviews.id })
        .from(reviews)
        .where(and(eq(reviews.id, reviewId), eq(reviews.project_id, projectId)))
        .limit(1);
      if (!review) {
        throw new NotFoundError("Review not found", "review_not_found");
      }

      const rows = await db
        .select()
        .from(reviewTokens)
        .where(and(
          eq(reviewTokens.review_id, reviewId),
          eq(reviewTokens.is_preview, false),
        ))
        .orderBy(desc(reviewTokens.created_at))
        .limit(limit)
        .offset(offset);

      const [{ count }] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(reviewTokens)
        .where(and(
          eq(reviewTokens.review_id, reviewId),
          eq(reviewTokens.is_preview, false),
        ));

      const total = Number(count);
      const has_more = offset + rows.length < total;

      return { items: rows.map(toTokenHistoryRow), total, has_more };
    },
  };
}

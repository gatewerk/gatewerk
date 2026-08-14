import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviews, templates } from "@gatewerk/db/src/schema/index";
import { generateId, ConflictError, InvalidRequestError, NotFoundError } from "@gatewerk/shared";
import { createReviewTokenService } from "../services/review-tokens";

describe("ReviewTokenService", () => {
  let db: any;
  let client: any;
  let projectId: string;
  let templateId: string;
  let tokenService: ReturnType<typeof createReviewTokenService>;

  // Token-redesign Phase 1: generate now transitions pending → awaiting_external,
  // so each test that calls generate needs its own fresh pending review.
  async function createPendingReview(): Promise<string> {
    const [rev] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: projectId,
      template_id: templateId,
      template_slug: "token-test",
      payload: { text: "fresh" },
      callback_url: "https://example.com/cb",
      status: "pending",
    }).returning();
    return rev.id;
  }

  function generateInput(reviewId: string, overrides: Partial<{ expiryHours: number; created_by_kind: "manual" | "chain" | "agent"; created_by_id: string }> = {}) {
    return {
      review_id: reviewId,
      project_id: projectId,
      purpose: "test purpose",
      recipient_label: "test recipient",
      created_by_kind: overrides.created_by_kind ?? ("manual" as const),
      created_by_id: overrides.created_by_id ?? "test-user-id",
      ...(overrides.expiryHours !== undefined ? { expiryHours: overrides.expiryHours } : {}),
    };
  }

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    tokenService = createReviewTokenService(db);

    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "token-test",
      project_id: projectId,
      name: "Token Test Template",
      fields: [{ name: "text", type: "text", label: "Text" }],
      actions: ["approve", "reject"],
      enable_review_links: true,
    }).returning();
    templateId = tpl.id;
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  describe("generate", () => {
    it("returns a raw token starting with gw_tok_", async () => {
      const reviewId = await createPendingReview();
      const result = await tokenService.generate(generateInput(reviewId));
      expect(result.rawToken).toMatch(/^gw_tok_/);
      expect(result.tokenRecord.review_id).toBe(reviewId);
      expect(result.tokenRecord.project_id).toBe(projectId);
      expect(result.tokenRecord.used_at).toBeNull();
    });

    it("sets expires_at to 48 hours from now by default", async () => {
      const reviewId = await createPendingReview();
      const result = await tokenService.generate(generateInput(reviewId));
      const expiresAt = new Date(result.tokenRecord.expires_at).getTime();
      const expected = Date.now() + 48 * 60 * 60 * 1000;
      expect(Math.abs(expiresAt - expected)).toBeLessThan(5000);
    });

    it("accepts custom expiry in hours", async () => {
      const reviewId = await createPendingReview();
      const result = await tokenService.generate(generateInput(reviewId, { expiryHours: 1 }));
      const expiresAt = new Date(result.tokenRecord.expires_at).getTime();
      const expected = Date.now() + 1 * 60 * 60 * 1000;
      expect(Math.abs(expiresAt - expected)).toBeLessThan(5000);
    });

    it("rejects generation when review is not pending", async () => {
      const reviewId = await createPendingReview();
      // Generate once → review now in awaiting_external. Second generate must fail.
      await tokenService.generate(generateInput(reviewId));
      await expect(tokenService.generate(generateInput(reviewId))).rejects.toBeInstanceOf(ConflictError);
    });

    it("rejects generation when the review id does not exist", async () => {
      await expect(
        tokenService.generate(generateInput("gw_rev_definitely_missing")),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("lifecycle (status transitions)", () => {
    it("transitions review pending → awaiting_external on generate", async () => {
      const reviewId = await createPendingReview();
      await tokenService.generate(generateInput(reviewId));

      const [updated] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
      expect(updated.status).toBe("awaiting_external");
    });

    it("leaves review.status untouched on consume (decide path owns the decided transition)", async () => {
      const reviewId = await createPendingReview();
      const { rawToken } = await tokenService.generate(generateInput(reviewId));
      await tokenService.consume(rawToken, {
        decision: "approved",
        ip_address: "127.0.0.1",
        user_agent: "Test/1.0",
      });

      const [afterConsume] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
      // Service-level consume only stamps the token row; review.status is
      // moved to "decided" by executeReviewAction in the route layer. At
      // this isolated service test, status stays at awaiting_external.
      expect(afterConsume.status).toBe("awaiting_external");
    });
  });

  describe("validate", () => {
    it("returns review data for a valid token (awaiting_external review)", async () => {
      const reviewId = await createPendingReview();
      const { rawToken } = await tokenService.generate(generateInput(reviewId));
      const result = await tokenService.validate(rawToken);
      expect(result).not.toBeNull();
      expect(result!.review.id).toBe(reviewId);
      expect(result!.review.status).toBe("awaiting_external");
      expect(result!.status).toBe("valid");
    });

    it("returns null for a non-existent token", async () => {
      const result = await tokenService.validate("gw_tok_nonexistent123456");
      expect(result).toBeNull();
    });

    it("returns expired status for an expired token", async () => {
      const reviewId = await createPendingReview();
      const { rawToken } = await tokenService.generate(generateInput(reviewId, { expiryHours: 0 }));
      const result = await tokenService.validate(rawToken);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("expired");
    });
  });

  describe("consume", () => {
    it("marks token as used and returns updated review", async () => {
      const reviewId = await createPendingReview();
      const { rawToken } = await tokenService.generate(generateInput(reviewId));
      const result = await tokenService.consume(rawToken, {
        decision: "approved",
        ip_address: "127.0.0.1",
        user_agent: "Test/1.0",
      });

      expect(result.success).toBe(true);
      expect(result.tokenRecord!.used_at).not.toBeNull();
      expect(result.tokenRecord!.decision).toBe("approved");
      expect(result.tokenRecord!.ip_address).toBe("127.0.0.1");
    });

    it("rejects consuming an already-used token", async () => {
      const reviewId = await createPendingReview();
      const { rawToken } = await tokenService.generate(generateInput(reviewId));
      await tokenService.consume(rawToken, {
        decision: "approved",
        ip_address: "127.0.0.1",
        user_agent: "Test/1.0",
      });
      const result = await tokenService.consume(rawToken, {
        decision: "rejected",
        ip_address: "127.0.0.1",
        user_agent: "Test/1.0",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("already_used");
    });

    it("rejects consuming an expired token", async () => {
      const reviewId = await createPendingReview();
      const { rawToken } = await tokenService.generate(generateInput(reviewId, { expiryHours: 0 }));
      const result = await tokenService.consume(rawToken, {
        decision: "approved",
        ip_address: "127.0.0.1",
        user_agent: "Test/1.0",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("expired");
    });
  });

  describe("preview from awaiting_external", () => {
    it("allows a preview token while a live link exists", async () => {
      const reviewId = await createPendingReview();
      await tokenService.generate(generateInput(reviewId)); // → awaiting_external

      const result = await tokenService.generate({
        ...generateInput(reviewId),
        is_preview: true,
      });

      expect(result.tokenRecord.is_preview).toBe(true);
      // Preview must NOT change review state
      const [rev] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
      expect(rev.status).toBe("awaiting_external");
    });

    it("still rejects a NON-preview token from awaiting_external", async () => {
      const reviewId = await createPendingReview();
      await tokenService.generate(generateInput(reviewId));

      await expect(tokenService.generate(generateInput(reviewId))).rejects.toThrow(
        ConflictError,
      );
    });
  });

  describe("extend", () => {
    it("pushes the active token's expiry out by N hours", async () => {
      const reviewId = await createPendingReview();
      const gen = await tokenService.generate(generateInput(reviewId, { expiryHours: 24 }));
      const before = new Date(gen.tokenRecord.expires_at).getTime();

      const result = await tokenService.extend({ review_id: reviewId, hours: 24 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.expires_at.getTime()).toBe(before + 24 * 3_600_000);
      }
    });

    it("returns no_active_token when nothing to extend", async () => {
      const reviewId = await createPendingReview();

      const result = await tokenService.extend({ review_id: reviewId, hours: 24 });

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBe("no_active_token");
    });

    it("does not extend a revoked token", async () => {
      const reviewId = await createPendingReview();
      await tokenService.generate(generateInput(reviewId));
      await tokenService.revoke({ review_id: reviewId, revoked_by: "reviewer:test" });

      const result = await tokenService.extend({ review_id: reviewId, hours: 24 });

      expect(result.success).toBe(false);
    });
  });

  describe("revoke", () => {
    it("revokes the active token and reverts the review to pending", async () => {
      const reviewId = await createPendingReview();
      await tokenService.generate(generateInput(reviewId));

      const result = await tokenService.revoke({
        review_id: reviewId,
        revoked_by: "reviewer:test",
        reason: "no longer needed",
      });

      expect(result.success).toBe(true);
      expect(result.success && result.reason).toBe("no longer needed");

      const [revertedReview] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
      expect(revertedReview.status).toBe("pending");
    });

    it("returns reason: null when no reason supplied", async () => {
      const reviewId = await createPendingReview();
      await tokenService.generate(generateInput(reviewId));

      const result = await tokenService.revoke({
        review_id: reviewId,
        revoked_by: "reviewer:test",
      });

      expect(result.success).toBe(true);
      expect(result.success && result.reason).toBeNull();
    });

    it("returns no_active_token when nothing to revoke", async () => {
      const reviewId = await createPendingReview();
      // No generate — no active token exists.

      const result = await tokenService.revoke({
        review_id: reviewId,
        revoked_by: "reviewer:test",
      });

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBe("no_active_token");
    });

    it("allows re-generation after revoke", async () => {
      const reviewId = await createPendingReview();
      await tokenService.generate(generateInput(reviewId));
      await tokenService.revoke({ review_id: reviewId, revoked_by: "reviewer:test" });

      // Should succeed since revoke restored pending.
      const result = await tokenService.generate(generateInput(reviewId));
      expect(result.rawToken).toMatch(/^gw_tok_/);
    });
  });

  // Helper-layer cross-field auth-tier gate (§13).
  // Defense-in-depth — catches bypass paths around the manual + chain wire
  // schemas (raw service callers, future bulk endpoints, agent SDK paths).
  // Same five stable error codes as the wire schemas so callers branch on
  // `code` uniformly across all entry surfaces.
  describe("generate — auth-tier cross-field gate (§13)", () => {
    it("T-GEN-GATE-1 — email_otp without auth_email throws auth_level.email_required", async () => {
      const reviewId = await createPendingReview();
      await expect(
        tokenService.generate({
          ...generateInput(reviewId),
          auth_level: "email_otp",
          auth_email: null,
        }),
      ).rejects.toMatchObject({
        name: "InvalidRequestError",
        code: "auth_level.email_required",
      });
    });

    it("T-GEN-GATE-2 — public + auth_email throws contextual_fields_not_allowed_for_public", async () => {
      const reviewId = await createPendingReview();
      await expect(
        tokenService.generate({
          ...generateInput(reviewId),
          auth_level: "public",
          auth_email: "x@y.z",
        }),
      ).rejects.toMatchObject({
        name: "InvalidRequestError",
        code: "auth_level.contextual_fields_not_allowed_for_public",
      });
    });

    it("T-GEN-GATE-3 — account with auth_user_id succeeds (positive control)", async () => {
      const reviewId = await createPendingReview();
      const result = await tokenService.generate({
        ...generateInput(reviewId),
        auth_level: "account",
        auth_user_id: "user_abc",
      });
      expect(result.rawToken).toMatch(/^gw_tok_/);
      expect(result.tokenRecord.auth_level).toBe("account");
      expect(result.tokenRecord.auth_user_id).toBe("user_abc");
      expect(result.tokenRecord.auth_email).toBeNull();
    });

    it("T-GEN-GATE-4 — account without auth_user_id throws user_id_required", async () => {
      const reviewId = await createPendingReview();
      await expect(
        tokenService.generate({
          ...generateInput(reviewId),
          auth_level: "account",
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);
    });
  });
});

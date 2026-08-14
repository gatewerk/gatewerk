import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq, and, count } from "drizzle-orm";
import { createHash } from "crypto";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { reviews, reviewTokens, auditLog } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

// GET /api/v1/reviews/expired-token-summary
// Returns {count, sample_review_ids} scoped to the calling reviewer's
// manually-issued tokens that expired without a decision while the
// parent review is still awaiting_external.
describe("GET /api/v1/reviews/expired-token-summary", () => {
  let app: any;
  let client: any;
  let db: any;
  let projectId: string;
  let reviewer: any;
  let sessionToken: string;
  // Second reviewer for scope-isolation test (case 8)
  let otherReviewer: any;
  let otherSessionToken: string;

  // Seed a bare review with status=awaiting_external.
  async function seedAwaitingReview(): Promise<string> {
    const [rev] = await db
      .insert(reviews)
      .values({
        id: generateId("review"),
        project_id: projectId,
        template_slug: "exp-token-test",
        payload: { subject: "test" },
        status: "awaiting_external",
      })
      .returning();
    return rev.id;
  }

  // Insert a raw review_tokens row with a past expires_at, no decision fields,
  // created_by_kind=manual, created_by_id=<userId>.
  async function seedExpiredToken(
    reviewId: string,
    userId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [tok] = await db
      .insert(reviewTokens)
      .values({
        id: generateId("token"),
        token_hash: createHash("sha256").update(`expired-${reviewId}-${suffix}`).digest("hex"),
        review_id: reviewId,
        project_id: projectId,
        expires_at: new Date(Date.now() - 86400 * 1000), // 1 day ago
        purpose: "test",
        recipient_label: "tester",
        auth_level: "public",
        created_by_kind: "manual",
        created_by_id: userId,
        is_preview: false,
        ...overrides,
      })
      .returning();
    return tok.id;
  }

  // Seed a live (not expired) manual token for a user.
  async function seedLiveToken(reviewId: string, userId: string): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [tok] = await db
      .insert(reviewTokens)
      .values({
        id: generateId("token"),
        token_hash: createHash("sha256").update(`live-${reviewId}-${userId}-${suffix}`).digest("hex"),
        review_id: reviewId,
        project_id: projectId,
        expires_at: new Date(Date.now() + 7 * 86400 * 1000), // 7 days from now
        purpose: "test-live",
        recipient_label: "tester-live",
        auth_level: "public",
        created_by_kind: "manual",
        created_by_id: userId,
        is_preview: false,
      })
      .returning();
    return tok.id;
  }

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;

    app = createApp({ db });

    const r1 = await seedReviewer(db, app, {
      email: "exp-banner-user@test.local",
      password: "password123",
      role: "admin",
    });
    reviewer = r1.reviewer;
    sessionToken = r1.sessionToken;

    const r2 = await seedReviewer(db, app, {
      email: "exp-banner-other@test.local",
      password: "password123",
      role: "reviewer",
    });
    otherReviewer = r2.reviewer;
    otherSessionToken = r2.sessionToken;
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("(1) returns count=0 when the user has issued no tokens", async () => {
    const res = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${sessionToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.sample_review_ids).toEqual([]);
  });

  it("(2) counts a manual token that is past-expiry, not revoked, not decided, review awaiting_external", async () => {
    const reviewId = await seedAwaitingReview();
    await seedExpiredToken(reviewId, reviewer.id);

    const res = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${sessionToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect(res.body.sample_review_ids).toContain(reviewId);
  });

  it("(3) excludes tokens decided via email_otp (decided_by_email IS NOT NULL)", async () => {
    const reviewId = await seedAwaitingReview();
    await seedExpiredToken(reviewId, reviewer.id, {
      decided_by_email: "voter@example.com",
    });
    // Positive control: another review that SHOULD appear
    const includedReviewId = await seedAwaitingReview();
    await seedExpiredToken(includedReviewId, reviewer.id);

    const res = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${sessionToken}`);

    // Excluded review must not appear
    expect(res.body.sample_review_ids).not.toContain(reviewId);
    // Positive control must appear (proves the query runs, not just returns [])
    expect(res.body.sample_review_ids).toContain(includedReviewId);
  });

  it("(4) excludes tokens decided via account (decided_by_user_id IS NOT NULL)", async () => {
    const reviewId = await seedAwaitingReview();
    await seedExpiredToken(reviewId, reviewer.id, {
      decided_by_user_id: generateId("user"),
    });
    const includedReviewId = await seedAwaitingReview();
    await seedExpiredToken(includedReviewId, reviewer.id);

    const res = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${sessionToken}`);

    expect(res.body.sample_review_ids).not.toContain(reviewId);
    expect(res.body.sample_review_ids).toContain(includedReviewId);
  });

  it("(5) excludes revoked tokens (revoked_at IS NOT NULL)", async () => {
    const reviewId = await seedAwaitingReview();
    await seedExpiredToken(reviewId, reviewer.id, {
      revoked_at: new Date(Date.now() - 3600 * 1000),
      revoked_by: "test",
    });
    const includedReviewId = await seedAwaitingReview();
    await seedExpiredToken(includedReviewId, reviewer.id);

    const res = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${sessionToken}`);

    expect(res.body.sample_review_ids).not.toContain(reviewId);
    expect(res.body.sample_review_ids).toContain(includedReviewId);
  });

  it("(6) excludes reviews that have a newer non-expired token (reshared by same user)", async () => {
    const reviewId = await seedAwaitingReview();
    // Token A: expired
    await seedExpiredToken(reviewId, reviewer.id);
    // Token B: still live — same user reshared
    await seedLiveToken(reviewId, reviewer.id);

    // Positive control: a different review with only an expired token
    const includedReviewId = await seedAwaitingReview();
    await seedExpiredToken(includedReviewId, reviewer.id);

    const res = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${sessionToken}`);

    expect(res.body.sample_review_ids).not.toContain(reviewId);
    expect(res.body.sample_review_ids).toContain(includedReviewId);
  });

  it("(7) excludes is_preview=true tokens", async () => {
    // Use a fresh reviewer to ensure the positive control is not lost to the 5-sample cap.
    const { reviewer: freshR, sessionToken: freshST } = await seedReviewer(db, app, {
      email: "exp-banner-preview@test.local",
      password: "password123",
      role: "reviewer",
    });
    const reviewId = await seedAwaitingReview();
    await seedExpiredToken(reviewId, freshR.id, { is_preview: true });
    const includedReviewId = await seedAwaitingReview();
    await seedExpiredToken(includedReviewId, freshR.id);

    const res = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${freshST}`);

    expect(res.body.sample_review_ids).not.toContain(reviewId);
    expect(res.body.sample_review_ids).toContain(includedReviewId);
  });

  it("(8) scopes by created_by_id — another user's expired tokens are not counted", async () => {
    const reviewId = await seedAwaitingReview();
    // Seed for otherReviewer only
    await seedExpiredToken(reviewId, otherReviewer.id);

    // Query as the primary reviewer — should not see other reviewer's token
    const res = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${sessionToken}`);

    expect(res.body.sample_review_ids).not.toContain(reviewId);

    // Other reviewer should see it
    const resOther = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${otherSessionToken}`);

    expect(resOther.body.sample_review_ids).toContain(reviewId);
  });

  it("(9) caps sample_review_ids at 5 entries when count is larger", async () => {
    // Seed 7 distinct expired-review tokens for the primary reviewer.
    // Each is a distinct review so review_id is unique across the 7.
    const reviewIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const reviewId = await seedAwaitingReview();
      reviewIds.push(reviewId);
      await seedExpiredToken(reviewId, reviewer.id);
    }

    const res = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${sessionToken}`);

    expect(res.status).toBe(200);
    // Count includes prior seeded reviews for this user across all tests,
    // but must be at least 7 at this point.
    expect(res.body.count).toBeGreaterThanOrEqual(7);
    expect(res.body.sample_review_ids.length).toBeLessThanOrEqual(5);
  });

  it("(10) excludes tokens whose review status is NOT awaiting_external (e.g. decided)", async () => {
    // Use a fresh reviewer to ensure the positive control is not lost to the 5-sample cap.
    const { reviewer: freshR, sessionToken: freshST } = await seedReviewer(db, app, {
      email: "exp-banner-decided@test.local",
      password: "password123",
      role: "reviewer",
    });

    const [rev] = await db
      .insert(reviews)
      .values({
        id: generateId("review"),
        project_id: projectId,
        template_slug: "exp-token-decided",
        payload: { subject: "already decided" },
        status: "decided",
      })
      .returning();

    await seedExpiredToken(rev.id, freshR.id);
    // Positive control
    const includedReviewId = await seedAwaitingReview();
    await seedExpiredToken(includedReviewId, freshR.id);

    const res = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${freshST}`);

    expect(res.body.sample_review_ids).not.toContain(rev.id);
    expect(res.body.sample_review_ids).toContain(includedReviewId);
  });

  it("(11) emits an audit row token.expired_summary_queried with actor=reviewer:<email> when count > 0", async () => {
    // Ensure at least one expired token exists for this reviewer (from earlier tests)
    const reviewId = await seedAwaitingReview();
    await seedExpiredToken(reviewId, reviewer.id);

    // Count audit rows before
    const [beforeRow] = await db
      .select({ total: count() })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "token.expired_summary_queried"),
          eq(auditLog.actor, `reviewer:${reviewer.email}`),
        ),
      );
    const before = Number(beforeRow?.total ?? 0);

    const res = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${sessionToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThan(0);

    // Allow a brief moment for the fire-and-forget audit write to complete.
    await new Promise((r) => setTimeout(r, 50));

    // Audit row must have been inserted
    const [afterRow] = await db
      .select({ total: count() })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "token.expired_summary_queried"),
          eq(auditLog.actor, `reviewer:${reviewer.email}`),
        ),
      );
    const after = Number(afterRow?.total ?? 0);

    expect(after).toBeGreaterThan(before);

    // Assert the details payload matches the response body
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "token.expired_summary_queried"),
          eq(auditLog.actor, `reviewer:${reviewer.email}`),
        ),
      )
      .orderBy(auditLog.created_at);

    const latestRow = auditRows[auditRows.length - 1];
    expect(latestRow.details.count).toBe(res.body.count);
    expect(latestRow.details.sample_review_ids).toEqual(res.body.sample_review_ids);
  });

  it("(12) does NOT emit audit when count = 0 (fresh reviewer, no expired tokens)", async () => {
    // Use a brand-new reviewer with no expired tokens — avoids coupling to test ordering.
    const noAuditResult = await seedReviewer(db, app, {
      email: "exp-banner-noaudit@test.local",
      password: "password123",
      role: "reviewer",
    });
    const noAuditReviewer = noAuditResult.reviewer;
    const noAuditSessionToken = noAuditResult.sessionToken;

    const [beforeRow] = await db
      .select({ total: count() })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "token.expired_summary_queried"),
          eq(auditLog.actor, `reviewer:${noAuditReviewer.email}`),
        ),
      );
    const before = Number(beforeRow?.total ?? 0);

    const res = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${noAuditSessionToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);

    await new Promise((r) => setTimeout(r, 50));

    const [afterRow] = await db
      .select({ total: count() })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "token.expired_summary_queried"),
          eq(auditLog.actor, `reviewer:${noAuditReviewer.email}`),
        ),
      );
    const after = Number(afterRow?.total ?? 0);

    // No new audit row when count=0
    expect(after).toBe(before);
  });

  it("(13) excludes tokens with created_by_kind != 'manual' (e.g. chain-issued tokens)", async () => {
    // Use a fresh reviewer to ensure positive control is not lost to the 5-sample cap.
    const { reviewer: freshR, sessionToken: freshST } = await seedReviewer(db, app, {
      email: "exp-banner-chain@test.local",
      password: "password123",
      role: "reviewer",
    });
    const reviewId = await seedAwaitingReview();
    // Seed an agent-issued expired token — created_by_id set to freshR.id for
    // the outer query predicate (eq created_by_id, userId) to match, but
    // created_by_kind='chain' so the main-query filter excludes it.
    await seedExpiredToken(reviewId, freshR.id, { created_by_kind: "chain" });
    // Positive control: another review with a proper manual token
    const includedReviewId = await seedAwaitingReview();
    await seedExpiredToken(includedReviewId, freshR.id);

    const res = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${freshST}`);

    expect(res.body.sample_review_ids).not.toContain(reviewId);
    expect(res.body.sample_review_ids).toContain(includedReviewId);
  });

  it("(14) foreign-actor reshared case: peer admin's live token does NOT suppress the original user's expired token", async () => {
    // Use a fresh reviewer R so the positive-control reviewId appears in the sample.
    const { reviewer: freshR, sessionToken: freshST } = await seedReviewer(db, app, {
      email: "exp-banner-foreign@test.local",
      password: "password123",
      role: "reviewer",
    });

    // Reviewer freshR has an expired manual token on review X.
    const reviewId = await seedAwaitingReview();
    await seedExpiredToken(reviewId, freshR.id);

    // Another reviewer (otherReviewer) has a LIVE manual token on the same review X
    // (they reshared independently after freshR's token expired).
    await seedLiveToken(reviewId, otherReviewer.id);

    // freshR's banner MUST still include review X — otherReviewer's reshare must
    // NOT suppress it. This locks the FIX 1 contract: liveTokenReviewIds is now
    // scoped to created_by_id = freshR.id so a peer's share doesn't interfere.
    const res = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${freshST}`);

    expect(res.status).toBe(200);
    expect(res.body.sample_review_ids).toContain(reviewId);
  });

  // Was skipped with a TODO saying AppDeps had no auditService injection point.
  // It has one (app.ts:83), so the contract is now tested rather than asserted.
  it("(15) audit-log failure does NOT 500 the read (fire-and-forget contract)", async () => {
    const { reviewer: freshR, sessionToken: freshST } = await seedReviewer(db, app, {
      email: "exp-banner-auditfail@test.local",
      password: "password123",
      role: "reviewer",
    });
    const reviewId = await seedAwaitingReview();
    await seedExpiredToken(reviewId, freshR.id);

    // The route only audits when count > 0, so a rejecting log is unreachable
    // unless the banner actually has something to report. Confirm it does on
    // the real app first, otherwise this test passes for the wrong reason.
    const control = await request(app)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${freshST}`);
    expect(control.body.count).toBeGreaterThan(0);

    let logCalls = 0;
    const failingAudit = {
      log: () => {
        logCalls++;
        return Promise.reject(new Error("audit backend down"));
      },
      logBestEffort: () => {},
    } as unknown as Parameters<typeof createApp>[0] extends { auditService?: infer A }
      ? NonNullable<A>
      : never;

    const appWithFailingAudit = createApp({ db, auditService: failingAudit });

    const res = await request(appWithFailingAudit)
      .get("/api/v1/reviews/expired-token-summary")
      .set("Authorization", `Bearer ${freshST}`);

    // The banner is the point. Losing an audit row is lower severity than
    // blanking the banner on every poll during an audit outage, which would
    // tell the operator there are no expired tokens when there are.
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThan(0);
    expect(res.body.sample_review_ids).toContain(reviewId);
    expect(logCalls).toBeGreaterThan(0);
  });
});

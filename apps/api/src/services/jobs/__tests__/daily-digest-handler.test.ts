import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { sql } from "drizzle-orm";
import { createApp } from "../../../app";
import { createTestDb, seedTestProject, seedReviewer } from "../../../__tests__/helpers/test-db";
import { reviews, reviewTokens, organizations, organizationMemberships } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { runDailyDigest } from "../daily-digest-handler";

// Lets one specific test make resolveTenantOrgId throw for exactly one
// reviewer, to prove that a single reviewer's resolver failure (Fix 3)
// degrades only that reviewer's digest rather than aborting every
// remaining reviewer's. vi.hoisted is required (not a plain module-level
// `let`) because vi.mock's factory is hoisted above this file's own top, so
// the mutable value it closes over must be created through vi.hoisted to
// avoid a TDZ reference error at mock-evaluation time. Mirrors
// notification-digest-handler.test.ts's identical setup.
const { failingReviewerId } = vi.hoisted(() => ({
  failingReviewerId: { current: null as string | null },
}));

vi.mock("../../../jobs/notification-slack-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../jobs/notification-slack-handler")>();
  return {
    ...actual,
    resolveTenantOrgId: vi.fn(async (db: any, n: any) => {
      if (n.reviewer_id === failingReviewerId.current) {
        throw new Error("simulated tenant resolution failure");
      }
      return actual.resolveTenantOrgId(db, n);
    }),
  };
});

function makeEmailService(): any {
  const sends: any[] = [];
  return {
    sends,
    async sendEmail(args: any) {
      sends.push(args);
      return { status: "sent", messageId: "test-" + sends.length };
    },
    async close() {},
  };
}

function makeAuditService(): any {
  const logs: any[] = [];
  return {
    logs,
    log: vi.fn(async (entry: any) => { logs.push(entry); }),
  };
}

describe("runDailyDigest", () => {
  let app: any;
  let client: any;
  let db: any;
  let projectId: string;

  async function seedAwaitingReview(): Promise<string> {
    const [rev] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: projectId,
      template_slug: "digest-test",
      payload: { subject: "test" },
      status: "awaiting_external",
    }).returning();
    return rev.id;
  }

  async function seedExpiredToken(reviewId: string, userId: string): Promise<void> {
    const suffix = Math.random().toString(36).slice(2, 10);
    await db.insert(reviewTokens).values({
      id: generateId("token"),
      token_hash: createHash("sha256").update(`exp-${reviewId}-${userId}-${suffix}`).digest("hex"),
      review_id: reviewId,
      project_id: projectId,
      expires_at: new Date(Date.now() - 86400 * 1000),
      purpose: "test-exp",
      recipient_label: "tester",
      auth_level: "public",
      created_by_kind: "manual",
      created_by_id: userId,
      is_preview: false,
    });
  }

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    app = createApp({ db });
  });

  beforeEach(async () => {
    // Reset the singleton row so each test starts from "never ran" state.
    // The handler ensures the row exists; this resets it to epoch.
    await db.execute(sql`
      INSERT INTO jobs_daily_digest_state (id, last_run_at) VALUES ('singleton', '1970-01-01T00:00:00Z'::timestamptz)
      ON CONFLICT (id) DO UPDATE SET last_run_at = '1970-01-01T00:00:00Z'::timestamptz
    `);
    // Reset existing test data — DELETE all tokens and reviews from previous tests.
    await db.execute(sql`DELETE FROM review_tokens`);
    await db.execute(sql`DELETE FROM reviews`);
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  afterEach(() => {
    // Guarantee the resolver-failure toggle never leaks into a later test,
    // even if the test that sets it fails partway through.
    failingReviewerId.current = null;
  });

  it("dispatches one email per reviewer with expired tokens", async () => {
    const alice = (await seedReviewer(db, app, { email: "h-alice@test.local", password: "password123", role: "admin" })).reviewer;
    const bob = (await seedReviewer(db, app, { email: "h-bob@test.local", password: "password123", role: "reviewer" })).reviewer;
    const r1 = await seedAwaitingReview();
    const r2 = await seedAwaitingReview();
    await seedExpiredToken(r1, alice.id);
    await seedExpiredToken(r2, bob.id);
    const email = makeEmailService();
    const audit = makeAuditService();

    const result = await runDailyDigest(db, email, audit, new Date());

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.dispatched).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
    }
    expect(email.sends).toHaveLength(2);
    const sortedTos = email.sends.map((s: any) => s.to).sort();
    expect(sortedTos).toEqual(["h-alice@test.local", "h-bob@test.local"]);
  });

  it("same-day re-run is a no-op (idempotency invariant)", async () => {
    const alice = (await seedReviewer(db, app, { email: "h-idem-alice@test.local", password: "password123", role: "admin" })).reviewer;
    const r1 = await seedAwaitingReview();
    await seedExpiredToken(r1, alice.id);
    const email = makeEmailService();
    const audit = makeAuditService();

    const first = await runDailyDigest(db, email, audit, new Date());
    const second = await runDailyDigest(db, email, audit, new Date());

    expect(first.status).toBe("completed");
    expect(second.status).toBe("skipped");
    expect(email.sends).toHaveLength(1);
  });

  it("next-calendar-day re-run is NOT skipped", async () => {
    const today = new Date("2026-05-20T09:00:00Z");
    const tomorrow = new Date("2026-05-21T09:00:00Z");

    vi.useFakeTimers();
    try {
      vi.setSystemTime(today);

      const alice = (await seedReviewer(db, app, { email: "h-nextday-alice@test.local", password: "password123", role: "admin" })).reviewer;
      const r1 = await seedAwaitingReview();
      await seedExpiredToken(r1, alice.id);
      const email = makeEmailService();
      const audit = makeAuditService();

      await runDailyDigest(db, email, audit, today);

      vi.setSystemTime(tomorrow);
      const result = await runDailyDigest(db, email, audit, tomorrow);

      expect(result.status).toBe("completed");
      expect(email.sends).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("transient email failure is captured and the job still completes for other reviewers", async () => {
    const alice = (await seedReviewer(db, app, { email: "h-tf-alice@test.local", password: "password123", role: "admin" })).reviewer;
    const bob = (await seedReviewer(db, app, { email: "h-tf-bob@test.local", password: "password123", role: "reviewer" })).reviewer;
    const r1 = await seedAwaitingReview();
    const r2 = await seedAwaitingReview();
    await seedExpiredToken(r1, alice.id);
    await seedExpiredToken(r2, bob.id);
    const email = makeEmailService();
    email.sendEmail = async (args: any) => {
      if (args.to === "h-tf-alice@test.local") throw new Error("SMTP timeout");
      email.sends.push(args);
      return { status: "sent", messageId: "ok" };
    };
    const audit = makeAuditService();

    const result = await runDailyDigest(db, email, audit, new Date());

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.dispatched).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(1);
    }
    expect(audit.logs.some((l: any) => l.action === "daily_digest.send_failed")).toBe(true);
  });

  it("txn-rollback contract: injected failure inside the txn leaves last_run_at unset", async () => {
    const alice = (await seedReviewer(db, app, { email: "h-roll-alice@test.local", password: "password123", role: "admin" })).reviewer;
    const r1 = await seedAwaitingReview();
    await seedExpiredToken(r1, alice.id);
    const email = makeEmailService();
    const audit = makeAuditService();

    let threw = false;
    try {
      await runDailyDigest(db, email, audit, new Date(), { _testOnly_injectFailureAfterDispatch: true });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Re-run with a fresh email service. If the txn properly rolled back,
    // last_run_at was never written, so this call should dispatch (not skip).
    const email2 = makeEmailService();
    const result = await runDailyDigest(db, email2, audit, new Date());
    expect(result.status).toBe("completed");
    expect(email2.sends.length).toBeGreaterThan(0);
  });

  it("rate_limited result is a single-attempt failure (no retry)", async () => {
    const alice = (await seedReviewer(db, app, { email: "h-rl-alice@test.local", password: "password123", role: "admin" })).reviewer;
    const r = await seedAwaitingReview();
    await seedExpiredToken(r, alice.id);
    let callCount = 0;
    const email: any = {
      sendEmail: async (_args: any) => {
        callCount++;
        return { status: "rate_limited", reason: "per_email" };
      },
    };
    const audit = makeAuditService();

    const result = await runDailyDigest(db, email, audit, new Date());

    expect(callCount).toBe(1); // no retry
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.failed).toBe(1);
      expect(result.dispatched).toBe(0);
      expect(result.skipped).toBe(0);
    }
  });

  it("status:failed retries up to maxAttempts then reports failed", async () => {
    vi.useFakeTimers();
    const alice = (await seedReviewer(db, app, { email: "h-rf-alice@test.local", password: "password123", role: "admin" })).reviewer;
    const r = await seedAwaitingReview();
    await seedExpiredToken(r, alice.id);
    let callCount = 0;
    const email: any = {
      sendEmail: async (_args: any) => {
        callCount++;
        return { status: "failed", error: "smtp_550" };
      },
    };
    const audit = makeAuditService();

    const p = runDailyDigest(db, email, audit, new Date());
    await vi.runAllTimersAsync();
    const result = await p;

    expect(callCount).toBe(3); // 3 attempts
    if (result.status === "completed") {
      expect(result.failed).toBe(1);
      expect(result.dispatched).toBe(0);
      expect(result.skipped).toBe(0);
    }
    vi.useRealTimers();
  });

  it("skipped_no_config counts as skipped (not dispatched)", async () => {
    const alice = (await seedReviewer(db, app, { email: "h-sn-alice@test.local", password: "password123", role: "admin" })).reviewer;
    const r = await seedAwaitingReview();
    await seedExpiredToken(r, alice.id);
    const email: any = { sendEmail: async () => ({ status: "skipped_no_config" }) };
    const audit = makeAuditService();

    const result = await runDailyDigest(db, email, audit, new Date());

    if (result.status === "completed") {
      expect(result.skipped).toBe(1);
      expect(result.dispatched).toBe(0);
      expect(result.failed).toBe(0);
    }
    expect(audit.logs.some((l: any) => l.action === "daily_digest.send_skipped_no_config")).toBe(true);
  });

  it("deduped counts as dispatched", async () => {
    const alice = (await seedReviewer(db, app, { email: "h-dd-alice@test.local", password: "password123", role: "admin" })).reviewer;
    const r = await seedAwaitingReview();
    await seedExpiredToken(r, alice.id);
    const email: any = { sendEmail: async () => ({ status: "deduped", messageId: "old" }) };
    const audit = makeAuditService();

    const result = await runDailyDigest(db, email, audit, new Date());

    if (result.status === "completed") {
      expect(result.dispatched).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
    }
  });

  // Fix 3: runDailyDigest previously passed no organization_id at all, so
  // this stream's bounces were never attributed and could never contribute
  // to any tenant's rate, despite the handler already having a
  // tenant_paused switch arm that made it read as covered. These three
  // tests genuinely fail against that implementation: the first asserts a
  // non-null organization_id that pre-fix is always undefined; the second
  // and third exercise the fail-open / fail-isolated contract that only
  // exists once the resolver call is wired in at all.
  it("attributes the digest send to the reviewer's sole organization", async () => {
    const dave = (
      await seedReviewer(db, app, { email: "h-org-dave@test.local", password: "password123", role: "admin" })
    ).reviewer;
    await db.insert(organizations).values({ id: "dd-org-dave", name: "Dave Org", slug: "dd-org-dave" });
    await db.insert(organizationMemberships).values({
      id: generateId("omem"),
      organization_id: "dd-org-dave",
      user_id: dave.id,
    });
    const r = await seedAwaitingReview();
    await seedExpiredToken(r, dave.id);

    const email = makeEmailService();
    const audit = makeAuditService();
    const result = await runDailyDigest(db, email, audit, new Date());

    expect(result.status).toBe("completed");
    expect(email.sends).toHaveLength(1);
    expect(email.sends[0].organization_id).toBe("dd-org-dave");
  });

  it("still sends the digest, with a null organization, when the reviewer's tenant is ambiguous", async () => {
    const erin = (
      await seedReviewer(db, app, { email: "h-org-erin@test.local", password: "password123", role: "admin" })
    ).reviewer;
    // Two memberships, no review to disambiguate — resolveTenantOrgId fails
    // closed with { ok: false }. The digest must still be sent, not dropped.
    await db.insert(organizations).values([
      { id: "dd-org-erin-a", name: "Erin Org A", slug: "dd-org-erin-a" },
      { id: "dd-org-erin-b", name: "Erin Org B", slug: "dd-org-erin-b" },
    ]);
    await db.insert(organizationMemberships).values([
      { id: generateId("omem"), organization_id: "dd-org-erin-a", user_id: erin.id },
      { id: generateId("omem"), organization_id: "dd-org-erin-b", user_id: erin.id },
    ]);
    const r = await seedAwaitingReview();
    await seedExpiredToken(r, erin.id);

    const email = makeEmailService();
    const audit = makeAuditService();
    const result = await runDailyDigest(db, email, audit, new Date());

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.dispatched).toBe(1);
    }
    expect(email.sends).toHaveLength(1);
    expect(email.sends[0].organization_id).toBe(null);
  });

  it("one reviewer's tenant-resolution failure does not stop the others' digests", async () => {
    const frank = (
      await seedReviewer(db, app, { email: "h-org-frank@test.local", password: "password123", role: "admin" })
    ).reviewer;
    const grace = (
      await seedReviewer(db, app, { email: "h-org-grace@test.local", password: "password123", role: "reviewer" })
    ).reviewer;
    const r1 = await seedAwaitingReview();
    const r2 = await seedAwaitingReview();
    await seedExpiredToken(r1, frank.id);
    await seedExpiredToken(r2, grace.id);

    // Frank's tenant resolution throws; Grace's resolves normally.
    failingReviewerId.current = frank.id;

    const email = makeEmailService();
    const audit = makeAuditService();
    const result = await runDailyDigest(db, email, audit, new Date());

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      // Grace's digest still went out; only Frank's counted as failed.
      expect(result.dispatched).toBe(1);
      expect(result.failed).toBe(1);
    }
    expect(email.sends).toHaveLength(1);
    expect(email.sends[0].to).toBe("h-org-grace@test.local");

    // The failure is audited against the right reviewer, not silently dropped.
    const failureLog = audit.logs.find(
      (l: any) => l.action === "daily_digest.send_failed" && l.resource_id === frank.id,
    );
    expect(failureLog).toBeTruthy();
  });
});

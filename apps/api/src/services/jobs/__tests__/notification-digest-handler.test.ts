import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createApp } from "../../../app";
import { createTestDb, seedTestProject, seedReviewer } from "../../../__tests__/helpers/test-db";
import {
  notifications,
  notificationPreferences,
  organizations,
  organizationMemberships,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { runNotificationDigest } from "../notification-digest-handler";

// Lets one specific test make resolveTenantOrgId throw for exactly one
// reviewer, to prove that a single reviewer's resolver failure degrades only
// that reviewer's digest rather than aborting every remaining reviewer's.
// vi.hoisted is required here (not a plain module-level `let`) because
// vi.mock's factory is hoisted above this file's own top, so the mutable
// value it closes over must be created through vi.hoisted to avoid a TDZ
// reference error at mock-evaluation time.
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
    log: async (entry: any) => { logs.push(entry); },
  };
}

describe("runNotificationDigest", () => {
  let app: any;
  let client: any;
  let db: any;

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;
    await seedTestProject(db);
    app = createApp({ db });
  });

  beforeEach(async () => {
    // Reset state singleton to epoch so each test starts fresh.
    await db.execute(sql`
      INSERT INTO jobs_notification_digest_state (id, last_run_at)
        VALUES ('singleton', '1970-01-01T00:00:00Z'::timestamptz)
        ON CONFLICT (id) DO UPDATE SET last_run_at = '1970-01-01T00:00:00Z'::timestamptz
    `);
    // Wipe notification data between tests.
    await db.execute(sql`DELETE FROM notification_preferences`);
    await db.execute(sql`DELETE FROM notifications`);
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  afterEach(() => {
    // Guarantee the resolver-failure toggle never leaks into a later test,
    // even if the test that sets it fails partway through.
    failingReviewerId.current = null;
  });

  it("sends one email per opted-in reviewer with unread notifications", async () => {
    const alice = (
      await seedReviewer(db, app, {
        email: "nd-alice@test.local",
        password: "password123",
        role: "reviewer",
      })
    ).reviewer;

    // Opt alice into digest.
    await db.insert(notificationPreferences).values({
      reviewer_id: alice.id,
      prefs: { digest: { enabled: true } },
    });

    // Seed an unread notification for alice.
    await db.insert(notifications).values({
      id: generateId("notification"),
      reviewer_id: alice.id,
      event: "review.assigned",
      category: "review",
      title: "New review needs your attention",
      dedup_key: `nd-test-${alice.id}-1`,
      read_at: null,
    });

    const email = makeEmailService();
    const audit = makeAuditService();

    const result = await runNotificationDigest(db, email, audit, new Date());

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.dispatched).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
    }

    expect(email.sends).toHaveLength(1);
    const sent = email.sends[0];
    expect(sent.to).toBe("nd-alice@test.local");
    // Must be non-transactional (digest category).
    expect(sent.is_transactional).toBe(false);
    // Must carry an unsubscribe URL pointing at the unsub endpoint.
    expect(sent.listUnsubscribeUrl).toBeDefined();
    expect(sent.listUnsubscribeUrl).toContain("/api/v1/unsub/");
  });

  it("same-day re-run sends nothing (idempotency)", async () => {
    const bob = (
      await seedReviewer(db, app, {
        email: "nd-bob@test.local",
        password: "password123",
        role: "reviewer",
      })
    ).reviewer;

    await db.insert(notificationPreferences).values({
      reviewer_id: bob.id,
      prefs: { digest: { enabled: true } },
    });

    await db.insert(notifications).values({
      id: generateId("notification"),
      reviewer_id: bob.id,
      event: "review.assigned",
      category: "review",
      title: "Urgent review",
      dedup_key: `nd-test-${bob.id}-2`,
      read_at: null,
    });

    const email = makeEmailService();
    const audit = makeAuditService();
    const now = new Date();

    const first = await runNotificationDigest(db, email, audit, now);
    const second = await runNotificationDigest(db, email, audit, now);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("skipped");
    // Only the first run should have sent.
    expect(email.sends).toHaveLength(1);
  });

  it("reviewer not opted in receives no email", async () => {
    const carol = (
      await seedReviewer(db, app, {
        email: "nd-carol@test.local",
        password: "password123",
        role: "reviewer",
      })
    ).reviewer;

    // Opt carol OUT (no prefs row → not picked up by predicate).
    await db.insert(notifications).values({
      id: generateId("notification"),
      reviewer_id: carol.id,
      event: "review.assigned",
      category: "review",
      title: "Review pending",
      dedup_key: `nd-test-${carol.id}-3`,
      read_at: null,
    });

    const email = makeEmailService();
    const audit = makeAuditService();

    const result = await runNotificationDigest(db, email, audit, new Date());

    // No prefs row means the predicate finds no batches.
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.dispatched).toBe(0);
    }
    expect(email.sends).toHaveLength(0);
  });

  it("attributes the digest send to the reviewer's sole organization", async () => {
    const dave = (
      await seedReviewer(db, app, {
        email: "nd-dave@test.local",
        password: "password123",
        role: "reviewer",
      })
    ).reviewer;

    await db.insert(notificationPreferences).values({
      reviewer_id: dave.id,
      prefs: { digest: { enabled: true } },
    });

    await db.insert(organizations).values({ id: "nd-org-dave", name: "Dave Org", slug: "nd-org-dave" });
    await db.insert(organizationMemberships).values({
      id: generateId("omem"),
      organization_id: "nd-org-dave",
      user_id: dave.id,
    });

    await db.insert(notifications).values({
      id: generateId("notification"),
      reviewer_id: dave.id,
      event: "review.assigned",
      category: "review",
      title: "Dave's review",
      dedup_key: `nd-test-${dave.id}-4`,
      read_at: null,
    });

    const email = makeEmailService();
    const audit = makeAuditService();
    const result = await runNotificationDigest(db, email, audit, new Date());

    expect(result.status).toBe("completed");
    expect(email.sends).toHaveLength(1);
    expect(email.sends[0].organization_id).toBe("nd-org-dave");
  });

  it("still sends the digest, with a null organization, when the reviewer's tenant is ambiguous", async () => {
    const erin = (
      await seedReviewer(db, app, {
        email: "nd-erin@test.local",
        password: "password123",
        role: "reviewer",
      })
    ).reviewer;

    await db.insert(notificationPreferences).values({
      reviewer_id: erin.id,
      prefs: { digest: { enabled: true } },
    });

    // Two memberships, no review to disambiguate — resolveTenantOrgId fails
    // closed with { ok: false }. The digest must still be sent, not dropped.
    await db.insert(organizations).values([
      { id: "nd-org-erin-a", name: "Erin Org A", slug: "nd-org-erin-a" },
      { id: "nd-org-erin-b", name: "Erin Org B", slug: "nd-org-erin-b" },
    ]);
    await db.insert(organizationMemberships).values([
      { id: generateId("omem"), organization_id: "nd-org-erin-a", user_id: erin.id },
      { id: generateId("omem"), organization_id: "nd-org-erin-b", user_id: erin.id },
    ]);

    await db.insert(notifications).values({
      id: generateId("notification"),
      reviewer_id: erin.id,
      event: "review.assigned",
      category: "review",
      title: "Erin's review",
      dedup_key: `nd-test-${erin.id}-5`,
      read_at: null,
    });

    const email = makeEmailService();
    const audit = makeAuditService();
    const result = await runNotificationDigest(db, email, audit, new Date());

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.dispatched).toBe(1);
    }
    expect(email.sends).toHaveLength(1);
    expect(email.sends[0].organization_id).toBe(null);
  });

  it("one reviewer's tenant-resolution failure does not stop the others' digests", async () => {
    const frank = (
      await seedReviewer(db, app, {
        email: "nd-frank@test.local",
        password: "password123",
        role: "reviewer",
      })
    ).reviewer;
    const grace = (
      await seedReviewer(db, app, {
        email: "nd-grace@test.local",
        password: "password123",
        role: "reviewer",
      })
    ).reviewer;

    await db.insert(notificationPreferences).values([
      { reviewer_id: frank.id, prefs: { digest: { enabled: true } } },
      { reviewer_id: grace.id, prefs: { digest: { enabled: true } } },
    ]);

    await db.insert(notifications).values([
      {
        id: generateId("notification"),
        reviewer_id: frank.id,
        event: "review.assigned",
        category: "review",
        title: "Frank's review",
        dedup_key: `nd-test-${frank.id}-6`,
        read_at: null,
      },
      {
        id: generateId("notification"),
        reviewer_id: grace.id,
        event: "review.assigned",
        category: "review",
        title: "Grace's review",
        dedup_key: `nd-test-${grace.id}-7`,
        read_at: null,
      },
    ]);

    // Frank's tenant resolution throws; Grace's resolves normally.
    failingReviewerId.current = frank.id;

    const email = makeEmailService();
    const audit = makeAuditService();
    const result = await runNotificationDigest(db, email, audit, new Date());

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      // Grace's digest still went out; only Frank's counted as failed.
      expect(result.dispatched).toBe(1);
      expect(result.failed).toBe(1);
    }
    expect(email.sends).toHaveLength(1);
    expect(email.sends[0].to).toBe("nd-grace@test.local");

    // The failure is audited against the right reviewer, not silently dropped.
    const failureLog = audit.logs.find(
      (l: any) => l.action === "notification_digest.send_failed" && l.resource_id === frank.id,
    );
    expect(failureLog).toBeTruthy();
  });
});

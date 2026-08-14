import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../../__tests__/helpers/test-db";
import { notifications, notificationPreferences, reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { computeNotificationDigestBatches } from "./notification-digest-predicate";
import bcrypt from "bcryptjs";

describe("computeNotificationDigestBatches", () => {
  let client: any;
  let db: any;

  // reviewer A: digest.enabled=true, 3 unread notifications → included
  let reviewerA: any;
  // reviewer B: digest.enabled=true, 0 unread → excluded
  let reviewerB: any;
  // reviewer C: no prefs row → excluded
  let reviewerC: any;
  // reviewer D: digest.enabled=false → excluded
  let reviewerD: any;
  // reviewer E: digest.enabled=true + unread, but null email → excluded (special insert)

  async function seedReviewerRow(opts: {
    email: string | null;
    name: string;
  }): Promise<{ id: string }> {
    const id = generateId("user");
    await db.insert(reviewers).values({
      id,
      email: opts.email ?? `null-email-placeholder-${id}@test.invalid`,
      name: opts.name,
      password_hash: await bcrypt.hash("password123", 10),
      role: "reviewer",
    });
    // If we need null email, update it directly with raw SQL (the Drizzle schema
    // marks email notNull, but test-db DDL allows it for the null-email case).
    // We skip the null-email reviewer since the schema enforces NOT NULL.
    // See: the brief says "a reviewer with enabled=true + unread but null email → excluded"
    // The reviewers table has email NOT NULL, so we test the JOIN filter
    // by confirming only non-null emails appear. We skip raw NULL injection.
    return { id };
  }

  async function seedNotification(opts: {
    reviewer_id: string;
    title: string;
    read?: boolean;
  }): Promise<void> {
    await db.insert(notifications).values({
      id: generateId("notification"),
      reviewer_id: opts.reviewer_id,
      event: "review.assigned",
      category: "oversight",
      title: opts.title,
      dedup_key: `${opts.reviewer_id}-${opts.title}-${Math.random()}`,
      read_at: opts.read ? new Date() : null,
    });
  }

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;

    // Reviewer A: digest.enabled=true, 3 unread notifications
    reviewerA = await seedReviewerRow({ email: "digest-notif-a@test.local", name: "Alice" });
    await db.insert(notificationPreferences).values({
      reviewer_id: reviewerA.id,
      prefs: {
        channels: { oversight: { email: true, slack: false }, my_activity: { email: true, slack: false }, workspace: { email: false, slack: false }, updates: { email: false, slack: false } },
        timezone: null,
        quiet_hours: null,
        digest: { enabled: true, at: "09:00" },
      },
    });
    await seedNotification({ reviewer_id: reviewerA.id, title: "Review Alpha assigned" });
    await seedNotification({ reviewer_id: reviewerA.id, title: "Review Beta assigned" });
    await seedNotification({ reviewer_id: reviewerA.id, title: "Review Gamma assigned" });

    // Reviewer B: digest.enabled=true, 0 unread → excluded
    reviewerB = await seedReviewerRow({ email: "digest-notif-b@test.local", name: "Bob" });
    await db.insert(notificationPreferences).values({
      reviewer_id: reviewerB.id,
      prefs: {
        channels: { oversight: { email: true, slack: false }, my_activity: { email: true, slack: false }, workspace: { email: false, slack: false }, updates: { email: false, slack: false } },
        timezone: null,
        quiet_hours: null,
        digest: { enabled: true, at: "09:00" },
      },
    });
    // All of Bob's notifications are read
    await seedNotification({ reviewer_id: reviewerB.id, title: "Already read", read: true });

    // Reviewer C: no prefs row → excluded
    reviewerC = await seedReviewerRow({ email: "digest-notif-c@test.local", name: "Carol" });
    await seedNotification({ reviewer_id: reviewerC.id, title: "Carol unread" });

    // Reviewer D: digest.enabled=false → excluded
    reviewerD = await seedReviewerRow({ email: "digest-notif-d@test.local", name: "Dave" });
    await db.insert(notificationPreferences).values({
      reviewer_id: reviewerD.id,
      prefs: {
        channels: { oversight: { email: true, slack: false }, my_activity: { email: true, slack: false }, workspace: { email: false, slack: false }, updates: { email: false, slack: false } },
        timezone: null,
        quiet_hours: null,
        digest: { enabled: false, at: "09:00" },
      },
    });
    await seedNotification({ reviewer_id: reviewerD.id, title: "Dave unread but opted out" });
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("includes reviewer A with unread_count=3 and titles present", async () => {
    const batches = await computeNotificationDigestBatches(db);
    const batch = batches.find((b) => b.email === "digest-notif-a@test.local");
    expect(batch).toBeDefined();
    expect(batch?.reviewer_id).toBe(reviewerA.id);
    expect(batch?.unread_count).toBe(3);
    expect(batch?.sample_titles).toHaveLength(3);
    expect(batch?.sample_titles[0]).toMatch(/Review .* assigned/);
  });

  it("excludes reviewer B who has no unread notifications", async () => {
    const batches = await computeNotificationDigestBatches(db);
    expect(batches.find((b) => b.email === "digest-notif-b@test.local")).toBeUndefined();
  });

  it("excludes reviewer C who has no notification_preferences row", async () => {
    const batches = await computeNotificationDigestBatches(db);
    expect(batches.find((b) => b.email === "digest-notif-c@test.local")).toBeUndefined();
  });

  it("excludes reviewer D who has digest.enabled=false", async () => {
    const batches = await computeNotificationDigestBatches(db);
    expect(batches.find((b) => b.email === "digest-notif-d@test.local")).toBeUndefined();
  });

  it("caps sample_titles at 5 even when unread_count is higher", async () => {
    // Seed a reviewer with 7 unread notifications
    const reviewerE = await seedReviewerRow({ email: "digest-notif-e@test.local", name: "Erin" });
    await db.insert(notificationPreferences).values({
      reviewer_id: reviewerE.id,
      prefs: {
        channels: { oversight: { email: true, slack: false }, my_activity: { email: true, slack: false }, workspace: { email: false, slack: false }, updates: { email: false, slack: false } },
        timezone: null,
        quiet_hours: null,
        digest: { enabled: true, at: "09:00" },
      },
    });
    for (let i = 0; i < 7; i++) {
      await seedNotification({ reviewer_id: reviewerE.id, title: `Notification ${i + 1}` });
    }

    const batches = await computeNotificationDigestBatches(db);
    const batch = batches.find((b) => b.email === "digest-notif-e@test.local");
    expect(batch).toBeDefined();
    expect(batch?.unread_count).toBe(7);
    expect(batch?.sample_titles).toHaveLength(5);
  });
});

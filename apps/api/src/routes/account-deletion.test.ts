import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedReviewer, seedTestProject } from "../__tests__/helpers/test-db";
import {
  notifications,
  notificationPreferences,
  slackUserLinks,
  productFeedback,
  auditLog,
} from "@gatewerk/db/src/schema/index";
import { generateId, DEFAULT_NOTIFICATION_PREFS } from "@gatewerk/shared";

// DELETE /account anonymizes the reviewers row in place rather than deleting
// it, so it never benefits from a foreign key
// cascade. These four tables have no other deletion path, so without an
// explicit delete here they would keep this reviewer's data (notification
// titles, their notification preferences, their Slack user id, and any
// product_feedback free text they submitted) forever.
// Separately, this reviewer's audit_log rows must be anonymized (personal
// fields stripped) rather than deleted outright — the rows themselves are a
// record that the actions happened and must survive.
describe("DELETE /account — data deletion", () => {
  it("deletes notifications, notification_preferences, slack_user_links, and product_feedback rows, and anonymizes (without deleting) this reviewer's audit_log rows", async () => {
    const { db } = await createTestDb();
    const app = createApp({ db });

    const { reviewer, sessionToken } = await seedReviewer(db, app, {
      email: "delete-me@test.com",
    });
    const { project } = await seedTestProject(db);

    // A pre-existing audit_log row for this reviewer, inserted directly
    // (not relying on seedReviewer's own login write, which is itself
    // fire-and-forget and would make this setup racy). Mirrors a real
    // auth.login_success entry's shape, including the PII fields the scrub
    // must strip.
    const priorAuditId = generateId("event");
    await db.insert(auditLog).values({
      id: priorAuditId,
      action: "auth.login_success",
      actor: reviewer.id,
      resource_type: "session",
      resource_id: "session_test",
      details: { ip: "203.0.113.7", user_agent: "test-agent/1.0" },
    });

    const preDeleteAuditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actor, reviewer.id));
    expect(preDeleteAuditRows.length).toBeGreaterThan(0);
    const preDeleteIds = preDeleteAuditRows.map((r: any) => r.id).sort();
    const totalAuditRowsBeforeDelete = (await db.select().from(auditLog)).length;

    const notificationId = generateId("notification");
    await db.insert(notifications).values({
      id: notificationId,
      reviewer_id: reviewer.id,
      review_id: null,
      event: "review.created",
      category: "oversight",
      title: "Your turn: agent fired a tool",
      dedup_key: notificationId,
    });

    await db.insert(notificationPreferences).values({
      reviewer_id: reviewer.id,
      prefs: DEFAULT_NOTIFICATION_PREFS,
    });

    await db.insert(slackUserLinks).values({
      reviewer_id: reviewer.id,
      slack_user_id: "U_TEST",
      slack_team_id: "T_TEST",
    });

    // subject stores the reviewer id — free-text user content submitted
    // through the product_feedback modal, same deletion concern as the
    // notification title above.
    const feedbackId = generateId("product_feedback");
    await db.insert(productFeedback).values({
      id: feedbackId,
      project_id: project.id,
      subject: reviewer.id,
      message: "Please add more keyboard shortcuts",
    });

    const res = await request(app)
      .delete("/api/v1/auth/account")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ current_password: "password123" });

    expect(res.status).toBe(200);

    const remainingNotifications = await db
      .select()
      .from(notifications)
      .where(eq(notifications.reviewer_id, reviewer.id));
    expect(remainingNotifications).toHaveLength(0);

    const remainingPrefs = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.reviewer_id, reviewer.id));
    expect(remainingPrefs).toHaveLength(0);

    const remainingSlackLinks = await db
      .select()
      .from(slackUserLinks)
      .where(eq(slackUserLinks.reviewer_id, reviewer.id));
    expect(remainingSlackLinks).toHaveLength(0);

    const remainingFeedback = await db
      .select()
      .from(productFeedback)
      .where(eq(productFeedback.subject, reviewer.id));
    expect(remainingFeedback).toHaveLength(0);

    // Audit rows: no longer findable under the reviewer's own id...
    const postDeleteByOldActor = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actor, reviewer.id));
    expect(postDeleteByOldActor).toHaveLength(0);

    // ...but the SAME rows still exist, now under the tombstone actor. This
    // (rather than just checking the old-actor query is empty) is what rules
    // out "the rows were deleted" as a false pass: a delete-instead-of-
    // anonymize implementation would also make postDeleteByOldActor empty.
    const anonymized = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actor, "[deleted]"));
    const anonymizedIds = anonymized.map((r: any) => r.id).sort();
    expect(anonymizedIds).toEqual(expect.arrayContaining(preDeleteIds));

    for (const row of anonymized) {
      const details = row.details as Record<string, unknown> | null;
      expect(details).not.toHaveProperty("email");
      expect(details).not.toHaveProperty("ip");
      expect(details).not.toHaveProperty("user_agent");
    }

    // Exactly one row was added during the request (account.deleted) and
    // none were removed — the audit trail must not lose entries wholesale.
    const totalAuditRowsAfterDelete = (await db.select().from(auditLog)).length;
    expect(totalAuditRowsAfterDelete).toBe(totalAuditRowsBeforeDelete + 1);
  });
});

// audit_log.actor is free-form text and call sites write six different shapes
// for the same person. Matching only the bare reviewer id — which is what this
// did — left plaintext email addresses in an append-only table with no purge.
describe("DELETE /account — every actor format is anonymized", () => {
  it("anonymizes all six formats for the deleted reviewer and touches nobody else's", async () => {
    const { db } = await createTestDb();
    const app = createApp({ db });

    const target = await seedReviewer(db, app, { email: "gone@test.com" });
    const bystander = await seedReviewer(db, app, { email: "stays@test.com" });

    // One row per format the codebase actually writes. The comment on each is
    // the call site that produces it; see reviewerActorValues().
    const formats = [
      target.reviewer.id, // auth/account/passkey/session routes
      "gone@test.com", // chain.completed via reviews.decided_by, no prefix
      "reviewer:gone@test.com", // formatActor(), hold, settings/team, decide
      `reviewer:${target.reviewer.id}`, // reviews/expired.ts email fallback
      "user:gone@test.com", // api-keys/lifecycle.ts test requests
      `user:${target.reviewer.id}`, // token-reviews-account-tier.ts
    ];

    const targetRowIds: string[] = [];
    for (const actor of formats) {
      const id = generateId("event");
      targetRowIds.push(id);
      await db.insert(auditLog).values({
        id,
        action: "auth.login_success",
        actor,
        resource_type: "session",
        resource_id: "session_test",
        details: {
          email: "gone@test.com",
          name: "Gone User",
          ip: "203.0.113.7",
          ip_address: "203.0.113.7",
          user_agent: "test-agent/1.0",
          verified_email: "gone@test.com",
          friendly_name: "Gone's laptop",
          review_id: "gw_rev_keepme",
        },
      });
    }

    // Same shapes for a different reviewer. An over-matching predicate (a LIKE
    // on "reviewer:%", say) would scrub these too, which is the failure mode a
    // "did the target get anonymized" assertion alone cannot see.
    const bystanderRowIds: string[] = [];
    for (const actor of [
      bystander.reviewer.id,
      "stays@test.com",
      "reviewer:stays@test.com",
      `user:${bystander.reviewer.id}`,
    ]) {
      const id = generateId("event");
      bystanderRowIds.push(id);
      await db.insert(auditLog).values({
        id,
        action: "auth.login_success",
        actor,
        resource_type: "session",
        resource_id: "session_test",
        details: { email: "stays@test.com", ip: "198.51.100.4" },
      });
    }

    const totalBefore = (await db.select().from(auditLog)).length;

    const res = await request(app)
      .delete("/api/v1/auth/account")
      .set("Authorization", `Bearer ${target.sessionToken}`)
      .send({ current_password: "password123" });
    expect(res.status).toBe(200);

    const all = await db.select().from(auditLog);
    const byId = new Map(all.map((r: any) => [r.id, r]));

    for (const id of targetRowIds) {
      const row = byId.get(id);
      // Still present: anonymized in place, not deleted.
      expect(row).toBeDefined();
      expect(row.actor).toBe("[deleted]");
      const details = row.details as Record<string, unknown>;
      for (const key of [
        "email",
        "name",
        "ip",
        "ip_address",
        "user_agent",
        "verified_email",
        "friendly_name",
      ]) {
        expect(details).not.toHaveProperty(key);
      }
      // Non-personal keys survive, or the row would stop being an audit record.
      expect(details.review_id).toBe("gw_rev_keepme");
    }

    for (const id of bystanderRowIds) {
      const row = byId.get(id);
      expect(row).toBeDefined();
      expect(row.actor).not.toBe("[deleted]");
      expect(row.details).toHaveProperty("email", "stays@test.com");
    }

    // account.deleted is the only row added; nothing is ever removed.
    expect(all.length).toBe(totalBefore + 1);
  });
});

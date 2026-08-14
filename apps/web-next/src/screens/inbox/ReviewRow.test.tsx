/**
 * ReviewRow.test.tsx — pure-function tests for unreadReviewIdSet.
 *
 * web-next has no React render harness (@testing-library/react not installed).
 * The visual dot and nav badge are verified via manual smoke (see task-10-report.md).
 *
 * These tests cover the core logic: which review_ids are considered unread.
 */
import { describe, it, expect } from "vitest";
import { unreadReviewIdSet } from "~/api/notifications";
import type { Notification } from "~/api/notifications";

function note(overrides: Partial<Notification>): Notification {
  return {
    id: "n1",
    review_id: "r1",
    read_at: null,
    ...overrides,
  };
}

describe("unreadReviewIdSet", () => {
  it("includes review_id when read_at is null (unread)", () => {
    const set = unreadReviewIdSet([note({ review_id: "r1", read_at: null })]);
    expect(set.has("r1")).toBe(true);
  });

  it("excludes review_id when read_at is set (already read)", () => {
    const set = unreadReviewIdSet([
      note({ review_id: "r2", read_at: "2026-07-25T12:00:00Z" }),
    ]);
    expect(set.has("r2")).toBe(false);
  });

  it("skips notifications with null review_id", () => {
    const set = unreadReviewIdSet([note({ review_id: null, read_at: null })]);
    expect(set.size).toBe(0);
  });

  it("handles a mixed set: unread included, read excluded, null review_id skipped", () => {
    const notifications: Notification[] = [
      note({ id: "n1", review_id: "r1", read_at: null }),           // unread → included
      note({ id: "n2", review_id: "r2", read_at: "2026-07-01T00:00:00Z" }), // read → excluded
      note({ id: "n3", review_id: null, read_at: null }),            // no review_id → skipped
      note({ id: "n4", review_id: "r3", read_at: null }),           // unread → included
    ];
    const set = unreadReviewIdSet(notifications);
    expect(set.has("r1")).toBe(true);
    expect(set.has("r2")).toBe(false);
    expect(set.has("r3")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("returns empty set for empty input", () => {
    expect(unreadReviewIdSet([]).size).toBe(0);
  });

  it("deduplicates: multiple unread notifications for same review yield one entry", () => {
    const set = unreadReviewIdSet([
      note({ id: "n1", review_id: "r1", read_at: null }),
      note({ id: "n2", review_id: "r1", read_at: null }),
    ]);
    expect(set.size).toBe(1);
    expect(set.has("r1")).toBe(true);
  });
});

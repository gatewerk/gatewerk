import { describe, it, expect } from "vitest";
import { resolveRecipients } from "./notification-recipients";
import { createTestDb } from "../__tests__/helpers/test-db";
import { reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import bcrypt from "bcryptjs";

describe("resolveRecipients", () => {
  it("resolves a reviewer UUID assignee to that reviewer", async () => {
    const { db } = await createTestDb();
    const [reviewer] = await db
      .insert(reviewers)
      .values({
        id: generateId("user"),
        email: "a@x.co",
        name: "a",
        password_hash: await bcrypt.hash("password123", 1),
        role: "reviewer",
      })
      .returning();

    const out = await resolveRecipients(db, {
      assignee: reviewer.id,
      id: "rev1",
    } as any);
    expect(out).toEqual([{ reviewerId: reviewer.id, email: "a@x.co" }]);
  });

  it("fans out a role assignee to all holders", async () => {
    const { db } = await createTestDb();

    const makeReviewer = (email: string, role: string) =>
      db
        .insert(reviewers)
        .values({
          id: generateId("user"),
          email,
          name: email.split("@")[0],
          password_hash: "x",
          role,
        })
        .returning()
        .then((rows) => rows[0]);

    const a = await makeReviewer("a@x.co", "reviewer");
    const b = await makeReviewer("b@x.co", "reviewer");
    await makeReviewer("c@x.co", "admin");

    const out = await resolveRecipients(db, {
      assignee: "role:reviewer",
      id: "rev1",
    } as any);
    expect(out.map((o) => o.reviewerId).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  });

  it("returns [] for null assignee", async () => {
    const { db } = await createTestDb();
    const out = await resolveRecipients(db, {
      assignee: null,
      id: "rev1",
    } as any);
    expect(out).toEqual([]);
  });

  it("resolves an email assignee to the matching reviewer's real id, not the email string", async () => {
    const { db } = await createTestDb();
    const [reviewer] = await db
      .insert(reviewers)
      .values({
        id: generateId("user"),
        email: "owner@x.co",
        name: "owner",
        password_hash: "x",
        role: "reviewer",
      })
      .returning();

    const out = await resolveRecipients(db, {
      assignee: "owner@x.co",
      id: "rev1",
    } as any);
    expect(out).toEqual([{ reviewerId: reviewer.id, email: "owner@x.co" }]);
  });

  it("falls back to an email only recipient when no reviewer matches the email", async () => {
    const { db } = await createTestDb();

    const out = await resolveRecipients(db, {
      assignee: "nobody@x.co",
      id: "rev1",
    } as any);
    expect(out).toEqual([{ reviewerId: "nobody@x.co", email: "nobody@x.co" }]);
  });
});

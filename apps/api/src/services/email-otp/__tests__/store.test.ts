import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  emailOtpCodes,
  reviews,
  reviewTokens,
  templates,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { createEmailOtpStore, OTP_CONSTANTS } from "../store";
import { hashOtpCode } from "../codes";
import { createTestDb, seedTestProject } from "../../../__tests__/helpers/test-db";

describe("email-otp/store", () => {
  let db: any;
  let client: any;
  let projectId: string;

  async function makeToken(): Promise<string> {
    const [tpl] = await db
      .insert(templates)
      .values({
        id: generateId("template"),
        slug: `tpl-${generateId("template").slice(-8)}`,
        project_id: projectId,
        name: "T",
        fields: [],
        actions: ["approve", "reject"],
      })
      .returning();
    const [rev] = await db
      .insert(reviews)
      .values({
        id: generateId("review"),
        project_id: projectId,
        template_id: tpl.id,
        template_slug: tpl.slug,
        payload: {},
        status: "pending",
      })
      .returning();
    const tokenId = generateId("token");
    await db.insert(reviewTokens).values({
      id: tokenId,
      token_hash: `hash-${tokenId}`,
      review_id: rev.id,
      project_id: projectId,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      purpose: "test",
      recipient_label: "test recipient",
      auth_level: "email_otp",
      auth_email: "alice@example.com",
      created_by_kind: "manual",
      created_by_id: "test",
    });
    return tokenId;
  }

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("createCode + getActiveCode returns the inserted row", async () => {
    const tokenId = await makeToken();
    const store = createEmailOtpStore(db);
    const codeHash = hashOtpCode("123456");
    const created = await store.createCode({
      tokenId,
      email: "alice@example.com",
      codeHash,
    });
    expect(created.id).toBeTruthy();
    expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const active = await store.getActiveCode(tokenId);
    expect(active).not.toBeNull();
    expect(active?.code_hash).toBe(codeHash);
    expect(active?.attempts).toBe(0);
  });

  it("getActiveCode returns null for an expired row", async () => {
    const tokenId = await makeToken();
    const store = createEmailOtpStore(db);
    // Direct insert with expires_at in the past — store.createCode
    // always stamps Date.now() + TTL so we bypass it for this case.
    const id = `gw_otp_expired_${tokenId.slice(-8)}`;
    await db.insert(emailOtpCodes).values({
      id,
      token_id: tokenId,
      email: "alice@example.com",
      code_hash: hashOtpCode("000000"),
      expires_at: new Date(Date.now() - 60_000),
    });
    const active = await store.getActiveCode(tokenId);
    expect(active).toBeNull();
  });

  it("getActiveCode returns the most-recent row when multiple rows exist", async () => {
    const tokenId = await makeToken();
    const store = createEmailOtpStore(db);
    const first = await store.createCode({
      tokenId,
      email: "alice@example.com",
      codeHash: hashOtpCode("111111"),
    });
    // Wait a millisecond so created_at differs reliably.
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.createCode({
      tokenId,
      email: "alice@example.com",
      codeHash: hashOtpCode("222222"),
    });
    const active = await store.getActiveCode(tokenId);
    expect(active?.id).toBe(second.id);
    expect(active?.id).not.toBe(first.id);
  });

  it("incrementAttempts is atomic and produces sequential counts", async () => {
    const tokenId = await makeToken();
    const store = createEmailOtpStore(db);
    const created = await store.createCode({
      tokenId,
      email: "alice@example.com",
      codeHash: hashOtpCode("333333"),
    });
    // 5 parallel increments — under TOCTOU we'd see fewer than 5; with
    // SQL-level atomic increment we always see exactly 5.
    const results = await Promise.all([
      store.incrementAttempts(created.id),
      store.incrementAttempts(created.id),
      store.incrementAttempts(created.id),
      store.incrementAttempts(created.id),
      store.incrementAttempts(created.id),
    ]);
    const max = Math.max(...results);
    expect(max).toBe(5);
    const active = await store.getActiveCode(tokenId);
    expect(active?.attempts).toBe(5);
  });

  it("markVerified excludes the row from getActiveCode", async () => {
    const tokenId = await makeToken();
    const store = createEmailOtpStore(db);
    const created = await store.createCode({
      tokenId,
      email: "alice@example.com",
      codeHash: hashOtpCode("444444"),
    });
    await store.markVerified(created.id);
    const active = await store.getActiveCode(tokenId);
    expect(active).toBeNull();
  });

  it("getMostRecentSendAt returns null when no sends exist", async () => {
    const tokenId = await makeToken();
    const store = createEmailOtpStore(db);
    const recent = await store.getMostRecentSendAt(tokenId);
    expect(recent).toBeNull();
  });

  it("lockToken + readLock round-trip", async () => {
    const tokenId = await makeToken();
    const store = createEmailOtpStore(db);
    expect(await store.readLock(tokenId)).toBeNull();
    await store.lockToken(tokenId);
    const lock = await store.readLock(tokenId);
    expect(lock).not.toBeNull();
    const expectedExpiry = Date.now() + OTP_CONSTANTS.LOCKOUT_DURATION_MS;
    // Allow 5s clock slack — the value should be very close to NOW + 1h.
    expect(lock!.getTime()).toBeGreaterThan(expectedExpiry - 5_000);
  });

  it("readLock returns null when the lock has expired", async () => {
    const tokenId = await makeToken();
    const store = createEmailOtpStore(db);
    // Set the lock manually to a past timestamp.
    await db
      .update(reviewTokens)
      .set({ otp_locked_until: new Date(Date.now() - 60_000) })
      .where(eq(reviewTokens.id, tokenId));
    expect(await store.readLock(tokenId)).toBeNull();
  });
});

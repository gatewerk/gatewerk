import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "crypto";
import { createApp } from "../../../app";
import { createTestDb, seedTestProject, seedReviewer } from "../../../__tests__/helpers/test-db";
import { reviews, reviewTokens } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { computeDailyDigestBatches } from "../daily-digest-predicate";

describe("computeDailyDigestBatches", () => {
  let app: any;
  let client: any;
  let db: any;
  let projectId: string;
  let alice: any;
  let bob: any;
  let carol: any;
  let dave: any;
  let erin: any;
  let fred: any;

  async function seedAwaitingReview(): Promise<string> {
    const [rev] = await db
      .insert(reviews)
      .values({
        id: generateId("review"),
        project_id: projectId,
        template_slug: "digest-test",
        payload: { subject: "test" },
        status: "awaiting_external",
      })
      .returning();
    return rev.id;
  }

  async function seedDecidedReview(): Promise<string> {
    const [rev] = await db
      .insert(reviews)
      .values({
        id: generateId("review"),
        project_id: projectId,
        template_slug: "digest-test",
        payload: { subject: "test" },
        status: "decided",
      })
      .returning();
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

  async function seedLiveToken(reviewId: string, userId: string): Promise<void> {
    const suffix = Math.random().toString(36).slice(2, 10);
    await db.insert(reviewTokens).values({
      id: generateId("token"),
      token_hash: createHash("sha256").update(`live-${reviewId}-${userId}-${suffix}`).digest("hex"),
      review_id: reviewId,
      project_id: projectId,
      expires_at: new Date(Date.now() + 7 * 86400 * 1000),
      purpose: "test-live",
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

    alice = (await seedReviewer(db, app, { email: "digest-alice@test.local", password: "password123", role: "admin" })).reviewer;
    bob = (await seedReviewer(db, app, { email: "digest-bob@test.local", password: "password123", role: "reviewer" })).reviewer;
    carol = (await seedReviewer(db, app, { email: "digest-carol@test.local", password: "password123", role: "reviewer" })).reviewer;
    dave = (await seedReviewer(db, app, { email: "digest-dave@test.local", password: "password123", role: "reviewer" })).reviewer;
    erin = (await seedReviewer(db, app, { email: "digest-erin@test.local", password: "password123", role: "reviewer" })).reviewer;
    fred = (await seedReviewer(db, app, { email: "digest-fred@test.local", password: "password123", role: "reviewer" })).reviewer;

    // Alice: 2 expired tokens on 2 awaiting reviews
    const ar1 = await seedAwaitingReview();
    const ar2 = await seedAwaitingReview();
    await seedExpiredToken(ar1, alice.id);
    await seedExpiredToken(ar2, alice.id);

    // Bob: 1 expired + 1 live on different reviews
    const br1 = await seedAwaitingReview();
    const br2 = await seedAwaitingReview();
    await seedExpiredToken(br1, bob.id);
    await seedLiveToken(br2, bob.id);

    // Carol: only live token, no expired
    const cr1 = await seedAwaitingReview();
    await seedLiveToken(cr1, carol.id);

    // Dave: expired token on a DECIDED review (must be excluded)
    const dr1 = await seedDecidedReview();
    await seedExpiredToken(dr1, dave.id);

    // Erin: expired + live on the SAME review (must be excluded — live sibling protects)
    const er1 = await seedAwaitingReview();
    await seedExpiredToken(er1, erin.id);
    await seedLiveToken(er1, erin.id);

    // Fred: 7 expired tokens (cap test)
    for (let i = 0; i < 7; i++) {
      const fr = await seedAwaitingReview();
      await seedExpiredToken(fr, fred.id);
    }
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("returns one batch per reviewer with expired manual tokens", async () => {
    const batches = await computeDailyDigestBatches(db, new Date());
    const alice_batch = batches.find(b => b.email === "digest-alice@test.local");
    const bob_batch = batches.find(b => b.email === "digest-bob@test.local");
    expect(alice_batch?.count).toBe(2);
    expect(bob_batch?.count).toBe(1);
    expect(alice_batch?.sample_review_ids).toHaveLength(2);
  });

  it("excludes reviewers whose only tokens are still live", async () => {
    const batches = await computeDailyDigestBatches(db, new Date());
    expect(batches.find(b => b.email === "digest-carol@test.local")).toBeUndefined();
  });

  it("excludes tokens whose review is no longer awaiting_external", async () => {
    const batches = await computeDailyDigestBatches(db, new Date());
    expect(batches.find(b => b.email === "digest-dave@test.local")).toBeUndefined();
  });

  it("excludes tokens that have a live sibling token on the same review", async () => {
    const batches = await computeDailyDigestBatches(db, new Date());
    expect(batches.find(b => b.email === "digest-erin@test.local")).toBeUndefined();
  });

  it("caps sample_review_ids at 5 even when more expired tokens exist", async () => {
    const batches = await computeDailyDigestBatches(db, new Date());
    const fred_batch = batches.find(b => b.email === "digest-fred@test.local");
    expect(fred_batch?.count).toBe(7);
    expect(fred_batch?.sample_review_ids).toHaveLength(5);
  });
});

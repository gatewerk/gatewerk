// Access control over stored review media.
//
// Two mounts serve attachments and neither had any auth:
//   - app.ts `/uploads` (express.static)          — every deployment, OSS included
//   - app.ts `/api/v1/media/:reviewId/:filename`  — cloud only, 302 to presigned R2
//
// These tests drive the `/uploads` surface because it is the one that exists
// in every mode; the cloud route is guarded by the same middleware instance,
// so the entitlement logic below is the logic both mounts run.
//
// The threat is not brute force. A stored file's name is derived from the
// TEMPLATE field name (services/media.ts storeBuffer: `${fieldName}${ext}`),
// so `receipt.jpg` is guessable outright and the review id is the entire
// secret — and review ids travel in webhook bodies and email.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// serverEnv freezes at module load, and app.ts reads UPLOADS_DIR through it,
// so the temp dir has to be in the environment before any import runs.
const UPLOADS = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const dir = mkdtempSync(join(tmpdir(), "gw-media-test-"));
  process.env.UPLOADS_DIR = dir;
  return dir;
});

import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviews, reviewTokens, templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

const FILE_BODY = "not-really-a-jpeg-but-bytes-are-bytes";

/** A served .jpg arrives as a Buffer with no `.text`; a refusal arrives as
 *  JSON. Read either, so "the bytes did not leak" is asserted the same way
 *  on both branches. */
function bodyText(res: { text?: string; body?: unknown }): string {
  if (typeof res.text === "string") return res.text;
  if (Buffer.isBuffer(res.body)) return res.body.toString("utf8");
  return JSON.stringify(res.body ?? "");
}

describe("Stored media access control", () => {
  let app: any;
  let client: any;
  let db: any;
  let apiKey: string;
  let projectId: string;
  let templateId: string;
  let templateSlug: string;

  async function createPendingReview(): Promise<string> {
    const [rev] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: projectId,
      template_id: templateId,
      template_slug: templateSlug,
      payload: { subject: "fresh" },
      callback_url: "https://example.com/cb",
      status: "pending",
    }).returning();
    // The file the review's `receipt` image field would have produced.
    const dir = join(UPLOADS, rev.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "receipt.jpg"), FILE_BODY);
    return rev.id;
  }

  async function mintToken(reviewId: string): Promise<string> {
    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/token`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ purpose: "media test", recipient_label: "External reviewer" });
    expect(res.status).toBe(201);
    return res.body.token;
  }

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;

    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "media-access-test",
      project_id: projectId,
      name: "Media Access Test",
      fields: [{ name: "receipt", type: "image", label: "Receipt" }],
      actions: ["approve", "reject"],
      enable_review_links: true,
    }).returning();
    templateId = tpl.id;
    templateSlug = tpl.slug;

    app = createApp({ db, emailTransport: { send: async () => ({ messageId: "test" }) } as any });
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("refuses an anonymous reader who knows the review id", async () => {
    const reviewId = await createPendingReview();
    const res = await request(app).get(`/uploads/${reviewId}/receipt.jpg`);
    expect(res.status).toBe(401);
    expect(bodyText(res)).not.toContain(FILE_BODY);
  });

  it("refuses a token minted for a DIFFERENT review", async () => {
    const reviewA = await createPendingReview();
    const reviewB = await createPendingReview();
    const tokenForA = await mintToken(reviewA);

    const res = await request(app)
      .get(`/uploads/${reviewB}/receipt.jpg`)
      .query({ token: tokenForA });

    expect(res.status).toBe(403);
    expect(bodyText(res)).not.toContain(FILE_BODY);
  });

  it("serves the recipient the media of the review their token is for", async () => {
    const reviewId = await createPendingReview();
    const token = await mintToken(reviewId);

    const res = await request(app)
      .get(`/uploads/${reviewId}/receipt.jpg`)
      .query({ token });

    expect(res.status).toBe(200);
    expect(bodyText(res)).toContain(FILE_BODY);
  });

  it("serves a project-scoped API key", async () => {
    const reviewId = await createPendingReview();
    const res = await request(app)
      .get(`/uploads/${reviewId}/receipt.jpg`)
      .set("Authorization", `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(bodyText(res)).toContain(FILE_BODY);
  });

  it("refuses a revoked token", async () => {
    const reviewId = await createPendingReview();
    const token = await mintToken(reviewId);

    await request(app)
      .post(`/api/v1/reviews/${reviewId}/token/revoke`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ reason: "no longer needed" })
      .expect(200);

    const res = await request(app)
      .get(`/uploads/${reviewId}/receipt.jpg`)
      .query({ token });

    expect(res.status).toBe(403);
    expect(bodyText(res)).not.toContain(FILE_BODY);
  });

  it("refuses an expired token", async () => {
    const reviewId = await createPendingReview();
    const token = await mintToken(reviewId);

    await db
      .update(reviewTokens)
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where(eq(reviewTokens.review_id, reviewId));

    const res = await request(app)
      .get(`/uploads/${reviewId}/receipt.jpg`)
      .query({ token });

    expect(res.status).toBe(403);
    expect(bodyText(res)).not.toContain(FILE_BODY);
  });

  it("refuses a well-formed token that was never issued", async () => {
    const reviewId = await createPendingReview();
    const res = await request(app)
      .get(`/uploads/${reviewId}/receipt.jpg`)
      .query({ token: "gw_tok_deadbeefdeadbeefdeadbeefdeadbeef" });

    expect(res.status).toBe(403);
    expect(bodyText(res)).not.toContain(FILE_BODY);
  });

  it("does not let a shared cache hold an entitled response", async () => {
    // The static mount shipped `maxAge: 7d, immutable`, i.e. Cache-Control
    // public. Once a response is entitlement-gated, a shared proxy caching it
    // would hand one recipient's attachment to the next requester.
    const reviewId = await createPendingReview();
    const token = await mintToken(reviewId);

    const res = await request(app)
      .get(`/uploads/${reviewId}/receipt.jpg`)
      .query({ token });

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/private/);
    expect(res.headers["cache-control"]).not.toMatch(/public/);
  });

  it("keeps traversal out of the review id segment", async () => {
    const reviewId = await createPendingReview();
    const token = await mintToken(reviewId);

    const res = await request(app)
      .get(`/uploads/${encodeURIComponent("../")}${reviewId}/receipt.jpg`)
      .query({ token });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(bodyText(res)).not.toContain(FILE_BODY);
  });
});

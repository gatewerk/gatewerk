import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { createApp } from "../app";

// Smallest well-known valid PNG (1x1 transparent pixel) — used rather than
// an arbitrary byte string so the magic-byte sniff in account.ts is
// exercised against a real file, not just four hand-picked bytes.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("Account avatar", () => {
  let db: any;
  let client: any;
  let app: Express;
  let sessionToken: string;
  let reviewerId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;
    await seedTestProject(db);
    app = createApp({ db });
    const seed = await seedReviewer(db, app, { email: "avatar-owner@test.com", role: "reviewer" });
    sessionToken = seed.sessionToken;
    reviewerId = seed.reviewer.id;
  });

  afterAll(async () => {
    await client?.close();
  });

  it("GET /avatar/:id 404s before any avatar is set", async () => {
    const res = await request(app).get(`/api/v1/auth/avatar/${reviewerId}`);
    expect(res.status).toBe(404);
  });

  it("PUT /avatar requires a session", async () => {
    const res = await request(app)
      .put("/api/v1/auth/avatar")
      .send({ data: `data:image/png;base64,${TINY_PNG_BASE64}` });
    expect(res.status).toBe(401);
  });

  it("rejects a disallowed content type before touching the bytes", async () => {
    const res = await request(app)
      .put("/api/v1/auth/avatar")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ data: `data:image/svg+xml;base64,${TINY_PNG_BASE64}` });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBeTruthy();
  });

  it("rejects a declared type that does not match the actual bytes", async () => {
    // Real PNG bytes, declared as JPEG — the sniff must catch this even
    // though "image/jpeg" is itself on the allow list.
    const res = await request(app)
      .put("/api/v1/auth/avatar")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ data: `data:image/jpeg;base64,${TINY_PNG_BASE64}` });
    expect(res.status).toBe(400);
  });

  it("rejects a payload over the size cap", async () => {
    // PNG magic bytes followed by 600KB of padding — passes the sniff, must
    // still be rejected on size before that check ever runs.
    const oversized = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.alloc(600 * 1024, 0),
    ]).toString("base64");
    const res = await request(app)
      .put("/api/v1/auth/avatar")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ data: `data:image/png;base64,${oversized}` });
    expect(res.status).toBe(400);
  });

  it("accepts a valid PNG, then serves it back with a matching content type", async () => {
    const putRes = await request(app)
      .put("/api/v1/auth/avatar")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ data: `data:image/png;base64,${TINY_PNG_BASE64}` });
    expect(putRes.status).toBe(200);
    expect(putRes.body.avatar_updated_at).toBeTruthy();

    const getRes = await request(app).get(`/api/v1/auth/avatar/${reviewerId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers["content-type"]).toBe("image/png");
    expect(Buffer.from(getRes.body).equals(Buffer.from(TINY_PNG_BASE64, "base64"))).toBe(true);
  });

  it("GET /avatar/:id needs no auth — it is deliberately public, id-gated only", async () => {
    const res = await request(app).get(`/api/v1/auth/avatar/${reviewerId}`);
    expect(res.status).toBe(200);
  });

  it("DELETE /avatar reverts to 404", async () => {
    const delRes = await request(app)
      .delete("/api/v1/auth/avatar")
      .set("Authorization", `Bearer ${sessionToken}`);
    expect(delRes.status).toBe(200);

    const getRes = await request(app).get(`/api/v1/auth/avatar/${reviewerId}`);
    expect(getRes.status).toBe(404);
  });

  it("DELETE /avatar requires a session", async () => {
    const res = await request(app).delete("/api/v1/auth/avatar");
    expect(res.status).toBe(401);
  });
});

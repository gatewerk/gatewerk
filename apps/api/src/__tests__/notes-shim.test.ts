import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

// Task 18 — RFC 8594 deprecation shim for /api/v1/reviews/:id/notes.
// AC #13: response carries Deprecation, Sunset (HTTP-date), and Link headers.
// AC #20a: response shape preserves the legacy {id, review_id, author,
// content, created_at} contract so existing API consumers (n8n nodes, SDKs,
// ComposeBar pre-Task 20) keep working through the v1.4 deprecation window.
describe("review notes shim (RFC 8594 deprecation) /api/v1/reviews/:id/notes", () => {
  let app: any;
  let db: any;
  let apiKey: string;
  let sessionToken: string;
  let projectId: string;
  let reviewId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    app = createApp({ db });

    // Session reviewer for the shim — both POST and GET require session auth
    // because the legacy handlers do (and notes inherit author identity from
    // the session subject).
    const { sessionToken: stoken } = await seedReviewer(db, app, {
      email: "shim-author@gatewerk.local",
      role: "reviewer",
      name: "Shim Author",
    });
    sessionToken = stoken;

    // Seed template + a real review (mirrors notes-attachments.test.ts).
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "test-review",
      project_id: projectId,
      name: "Test Review",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      default_priority: "normal",
    });
    const r = await request(app)
      .post("/api/v1/reviews")
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({ template: "test-review", payload: { content: "shim subject" } });
    reviewId = r.body.id;
  });

  const sessionAuth = () => ({ Authorization: `Bearer ${sessionToken}` });

  describe("POST /api/v1/reviews/:id/notes", () => {
    it("AC #13: response carries Deprecation, Sunset, and Link headers", async () => {
      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/notes`)
        .set(sessionAuth())
        .send({ content: "via shim" });
      expect(res.status).toBe(201);
      expect(res.headers["deprecation"]).toBe("true");
      expect(res.headers["sunset"]).toBe("Sat, 31 Dec 2026 23:59:59 GMT");
      expect(res.headers["link"]).toContain('</api/v1/notes>; rel="successor-version"');
    });

    it("AC #20a: response uses legacy shape {id, review_id, author, content, created_at}", async () => {
      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/notes`)
        .set(sessionAuth())
        .send({ content: "shape check" });
      expect(res.status).toBe(201);
      const expectedKeys = ["id", "review_id", "author", "content", "created_at"].sort();
      expect(Object.keys(res.body).sort()).toEqual(expectedKeys);
      expect(res.body.id).toMatch(/^gw_nt_/);
      expect(res.body.review_id).toBe(reviewId);
      expect(typeof res.body.author).toBe("string");
      expect(res.body.author.length).toBeGreaterThan(0);
      expect(res.body.content).toBe("shape check");
      expect(typeof res.body.created_at).toBe("string");
    });

    // M3: deprecation headers must be set on every response, including
    // validation failures. The current implementation calls
    // applyDeprecationHeaders inside the handler, which is bypassed when
    // validate() rejects the body — leaving 422 responses without the
    // deprecation signal that downstream API clients rely on for sunset
    // tracking.
    it("M3: 422 validation failure still carries Deprecation, Sunset, Link headers", async () => {
      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/notes`)
        .set(sessionAuth())
        .send({}); // missing required `content`
      expect(res.status).toBe(422);
      expect(res.headers["deprecation"]).toBe("true");
      expect(res.headers["sunset"]).toBe("Sat, 31 Dec 2026 23:59:59 GMT");
      expect(res.headers["link"]).toContain('</api/v1/notes>; rel="successor-version"');
    });
  });

  describe("GET /api/v1/reviews/:id/notes", () => {
    it("AC #13: response carries Deprecation, Sunset, and Link headers", async () => {
      const res = await request(app)
        .get(`/api/v1/reviews/${reviewId}/notes`)
        .set(sessionAuth());
      expect(res.status).toBe(200);
      expect(res.headers["deprecation"]).toBe("true");
      expect(res.headers["sunset"]).toBe("Sat, 31 Dec 2026 23:59:59 GMT");
      expect(res.headers["link"]).toContain('</api/v1/notes>; rel="successor-version"');
    });

    it("AC #20a: items use legacy shape {id, review_id, author, content, created_at}", async () => {
      // Seed at least one note via the shim so the read returns something.
      await request(app)
        .post(`/api/v1/reviews/${reviewId}/notes`)
        .set(sessionAuth())
        .send({ content: "for read shape" });

      const res = await request(app)
        .get(`/api/v1/reviews/${reviewId}/notes`)
        .set(sessionAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBeGreaterThan(0);
      const item = res.body.items[0];
      const expectedKeys = ["id", "review_id", "author", "content", "created_at"].sort();
      expect(Object.keys(item).sort()).toEqual(expectedKeys);
      expect(item.id).toMatch(/^gw_nt_/);
      expect(item.review_id).toBe(reviewId);
      expect(typeof item.author).toBe("string");
      expect(item.author.length).toBeGreaterThan(0);
      expect(typeof item.content).toBe("string");
      expect(typeof item.created_at).toBe("string");
    });
  });
});

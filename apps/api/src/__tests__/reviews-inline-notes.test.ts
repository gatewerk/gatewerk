// AC #10: GET /api/v1/reviews/:id returns inline notes visible to the
// requesting subject in a single round-trip. The visibility filter applies
// at the query level (jsonb_agg subquery in getByIdWithTemplate) so that a
// reviewer never sees another reviewer's private notes pinned to a review.
// `redactPrivateBody` runs on the returned rows as defense-in-depth.

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import {
  reviewers,
  templates,
  notes,
  noteAttachments,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("GET /api/v1/reviews/:id — inline notes (AC #10)", () => {
  let app: any;
  let db: any;
  let apiKey: string;
  let aliceToken: string;
  let aliceId: string;
  let bobId: string;
  let projectId: string;
  let reviewId: string;
  let noteAId: string; // shared by Bob — Alice should see
  let noteBId: string; // private by Alice — Alice should see (own)
  let noteCId: string; // private by Bob — Alice should NOT see

  beforeAll(async () => {
    const setup = await createTestDb();
    db = setup.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    // Two reviewers — Alice will be the request subject; Bob authors notes.
    aliceId = generateId("user");
    bobId = generateId("user");
    await db.insert(reviewers).values({
      id: aliceId,
      email: "alice@gatewerk.local",
      name: "Alice",
      password_hash: await bcrypt.hash("alice123", 10),
      role: "admin",
    });
    await db.insert(reviewers).values({
      id: bobId,
      email: "bob@gatewerk.local",
      name: "Bob",
      password_hash: await bcrypt.hash("bob123", 10),
      role: "reviewer",
    });

    // Template + review.
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "inline-notes-tpl",
      project_id: projectId,
      name: "Inline Notes Template",
      fields: [{ name: "topic", type: "text", label: "Topic" }],
      actions: ["approve", "reject"],
    });

    app = createApp({ db });

    const createRes = await request(app)
      .post("/api/v1/reviews")
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({
        template: "inline-notes-tpl",
        payload: { topic: "needs eyes" },
      });
    expect(createRes.status).toBe(201);
    reviewId = createRes.body.id;

    // Login Alice for session token.
    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "alice@gatewerk.local", password: "alice123" });
    expect(loginRes.status).toBe(200);
    aliceToken = loginRes.body.token;

    // Seed three notes pinned to the review:
    //   A: shared, authored by Bob → visible to anyone
    //   B: private, authored by Alice → visible to Alice (own)
    //   C: private, authored by Bob → NOT visible to Alice
    noteAId = generateId("note");
    noteBId = generateId("note");
    noteCId = generateId("note");
    await db.insert(notes).values([
      {
        id: noteAId,
        project_id: projectId,
        author_id: bobId,
        author_display_fallback: null,
        body: "shared by bob",
        tags: [],
        is_shared: true,
      },
      {
        id: noteBId,
        project_id: projectId,
        author_id: aliceId,
        author_display_fallback: null,
        body: "alice private",
        tags: [],
        is_shared: false,
      },
      {
        id: noteCId,
        project_id: projectId,
        author_id: bobId,
        author_display_fallback: null,
        body: "bob private — alice must not see",
        tags: [],
        is_shared: false,
      },
    ]);

    // Pin all three to the review (note attachments use the "pin" id prefix —
    // see routes/notes/write.ts and routes/notes/attachments.ts).
    await db.insert(noteAttachments).values([
      {
        id: generateId("pin"),
        note_id: noteAId,
        target_kind: "review",
        target_id: reviewId,
        attached_by: bobId,
      },
      {
        id: generateId("pin"),
        note_id: noteBId,
        target_kind: "review",
        target_id: reviewId,
        attached_by: aliceId,
      },
      {
        id: generateId("pin"),
        note_id: noteCId,
        target_kind: "review",
        target_id: reviewId,
        attached_by: bobId,
      },
    ]);
  });

  it("session caller (Alice) sees own private + shared, not Bob's private", async () => {
    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}`)
      .set({ Authorization: `Bearer ${aliceToken}` });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.notes)).toBe(true);
    expect(res.body.notes).toHaveLength(2);

    const ids = res.body.notes.map((n: any) => n.id).sort();
    expect(ids).toEqual([noteAId, noteBId].sort());
    expect(ids).not.toContain(noteCId);
  });

  it("each inline note exposes the expected shape", async () => {
    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}`)
      .set({ Authorization: `Bearer ${aliceToken}` });

    expect(res.status).toBe(200);
    const note = res.body.notes.find((n: any) => n.id === noteBId);
    expect(note).toBeDefined();
    expect(note.body).toBe("alice private");
    expect(note.is_shared).toBe(false);
    expect(note.author_id).toBe(aliceId);
    expect(Array.isArray(note.tags)).toBe(true);
    expect(Array.isArray(note.attachments)).toBe(true);
    expect(note.created_at).toBeDefined();
    expect(note.updated_at).toBeDefined();
  });

  it("api_key caller sees only the shared note", async () => {
    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}`)
      .set({ Authorization: `Bearer ${apiKey}` });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.notes)).toBe(true);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].id).toBe(noteAId);
    expect(res.body.notes[0].is_shared).toBe(true);
  });

  it("response still includes existing review/template fields (additive)", async () => {
    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}`)
      .set({ Authorization: `Bearer ${aliceToken}` });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(reviewId);
    expect(res.body.status).toBe("pending");
    expect(res.body.template).toBeDefined();
    expect(res.body.template.slug).toBe("inline-notes-tpl");
  });
});

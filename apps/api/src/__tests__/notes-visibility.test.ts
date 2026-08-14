import { describe, it, expect, beforeAll } from "vitest";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { generateId } from "@gatewerk/shared";
import { notes } from "@gatewerk/db/src/schema/index";
import { listNotesForSubject, redactPrivateBody } from "../services/notes-visibility";

describe("notes visibility filter", () => {
  let db: any, projectId: string;
  const userA = "gw_usr_aaaa";
  const userB = "gw_usr_bbbb";

  beforeAll(async () => {
    const setup = await createTestDb();
    db = setup.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;

    await db.insert(notes).values({
      id: generateId("note"), project_id: projectId,
      author_id: userA, author_display_fallback: null,
      body: "userA private", tags: [], is_shared: false,
    });
    await db.insert(notes).values({
      id: generateId("note"), project_id: projectId,
      author_id: userA, author_display_fallback: null,
      body: "userA shared", tags: [], is_shared: true,
    });
    await db.insert(notes).values({
      id: generateId("note"), project_id: projectId,
      author_id: userB, author_display_fallback: null,
      body: "userB private", tags: [], is_shared: false,
    });
  });

  it("userA sees own private + own shared, not userB private (AC #3)", async () => {
    const items = await listNotesForSubject(db, { project_id: projectId, subject_user_id: userA });
    expect(items.map((n) => n.body).sort()).toEqual(["userA private", "userA shared"]);
  });

  it("admin querying does not see other-user private notes (AC #4)", async () => {
    const adminId = "gw_usr_admin";
    const items = await listNotesForSubject(db, { project_id: projectId, subject_user_id: adminId });
    expect(items.map((n) => n.body)).toEqual(["userA shared"]);
  });

  it("api_key subject (null user_id) sees only shared", async () => {
    const items = await listNotesForSubject(db, { project_id: projectId, subject_user_id: null });
    expect(items.map((n) => n.body)).toEqual(["userA shared"]);
  });
});

describe("body redaction (defense in depth)", () => {
  it("redacts body when is_shared=false and author_id != subject", () => {
    const note = {
      id: "x", project_id: "p", author_id: "userA",
      author_display_fallback: null, body: "secret", tags: [],
      is_shared: false, created_at: "x", updated_at: "x",
    };
    const out = redactPrivateBody(note as any, { subject_user_id: "userB" });
    expect(out.body).toBe("");
  });

  it("preserves body when is_shared=true", () => {
    const note = {
      id: "x", project_id: "p", author_id: "userA",
      author_display_fallback: null, body: "team", tags: [],
      is_shared: true, created_at: "x", updated_at: "x",
    };
    const out = redactPrivateBody(note as any, { subject_user_id: "userB" });
    expect(out.body).toBe("team");
  });

  it("preserves body when subject is the author", () => {
    const note = {
      id: "x", project_id: "p", author_id: "userA",
      author_display_fallback: null, body: "my own", tags: [],
      is_shared: false, created_at: "x", updated_at: "x",
    };
    const out = redactPrivateBody(note as any, { subject_user_id: "userA" });
    expect(out.body).toBe("my own");
  });
});

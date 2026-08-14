import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, reviews } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

// Exercises the M9 Phase 1 API surface: POST /api/v1/reviews with
// `assignment_ladder`. Verifies:
//   * 400 on invalid ladder shapes (zod refinements).
//   * 201 on valid ladder sets the three server-managed columns.
//   * Assignee resolution: ladder[0].actor wins over caller-supplied
//     assignee when both are present.
//   * Server ignores client-supplied `ladder_index` / `ladder_next_promote_at`
//     — the zod schema doesn't declare them on the body, so they're silently
//     dropped.

describe("POST /api/v1/reviews — assignment_ladder", () => {
  let app: any;
  let apiKey: string;
  let db: any;
  let projectId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    await db.insert(templates).values({
      id: generateId("template"),
      slug: "ladder-api-test",
      project_id: projectId,
      name: "Ladder API Test",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });

    app = createApp({ db });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  it("201 — creates a review with the ladder columns set when a 3-step ladder is supplied", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "ladder-api-test",
        payload: { content: "needs escalation" },
        assignment_ladder: [
          { actor: "alice", trigger_after_seconds: 60 },
          { actor: "manager", trigger_after_seconds: 7200 },
          { actor: "admin", trigger_after_seconds: 14400 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.object).toBe("review");

    const reviewId: string = res.body.id;
    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(row).toBeDefined();
    expect(row.ladder_index).toBe(0);
    expect(row.assignee).toBe("alice");
    expect(row.assignment_ladder).toEqual([
      { actor: "alice", trigger_after_seconds: 60, status: "active" },
      { actor: "manager", trigger_after_seconds: 7200, status: "pending" },
      { actor: "admin", trigger_after_seconds: 14400, status: "pending" },
    ]);

    // ladder_next_promote_at is `created_at + ladder[1].trigger_after_seconds`.
    const expectedAt = new Date(row.created_at.getTime() + 7200 * 1000);
    expect(row.ladder_next_promote_at?.toISOString()).toBe(expectedAt.toISOString());
  });

  it("201 — null ladder_next_promote_at when only one ladder step is supplied", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "ladder-api-test",
        payload: { content: "single" },
        assignment_ladder: [{ actor: "alice", trigger_after_seconds: 60 }],
      });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(reviews).where(eq(reviews.id, res.body.id));
    expect(row.ladder_next_promote_at).toBeNull();
    expect(row.assignee).toBe("alice");
  });

  it("201 — ladder[0].actor overrides caller-supplied `assignee`", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "ladder-api-test",
        payload: { content: "override" },
        assignee: "someone-else",
        assignment_ladder: [
          { actor: "alice", trigger_after_seconds: 60 },
          { actor: "manager", trigger_after_seconds: 7200 },
        ],
      });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(reviews).where(eq(reviews.id, res.body.id));
    expect(row.assignee).toBe("alice");
  });

  it("422 — rejects trigger_after_seconds < 60", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "ladder-api-test",
        payload: { content: "x" },
        assignment_ladder: [{ actor: "alice", trigger_after_seconds: 30 }],
      });
    expect(res.status).toBe(422);
  });

  it("422 — rejects non-monotonic trigger_after_seconds", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "ladder-api-test",
        payload: { content: "x" },
        assignment_ladder: [
          { actor: "alice", trigger_after_seconds: 7200 },
          { actor: "manager", trigger_after_seconds: 60 },
        ],
      });
    expect(res.status).toBe(422);
  });

  it("422 — rejects empty ladder", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "ladder-api-test",
        payload: { content: "x" },
        assignment_ladder: [],
      });
    expect(res.status).toBe(422);
  });

  it("422 — rejects missing actor", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "ladder-api-test",
        payload: { content: "x" },
        assignment_ladder: [{ trigger_after_seconds: 60 }],
      });
    expect(res.status).toBe(422);
  });

  it("201 — no ladder supplied leaves ladder columns at defaults (ladder_index=0, other nulls)", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "ladder-api-test",
        payload: { content: "no ladder" },
      });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(reviews).where(eq(reviews.id, res.body.id));
    expect(row.assignment_ladder).toBeNull();
    expect(row.ladder_index).toBe(0);
    expect(row.ladder_next_promote_at).toBeNull();
  });

  it("server-managed fields — silently ignores client-supplied ladder_index / ladder_next_promote_at", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "ladder-api-test",
        payload: { content: "tamper" },
        ladder_index: 99,
        ladder_next_promote_at: "2020-01-01T00:00:00.000Z",
        assignment_ladder: [
          { actor: "alice", trigger_after_seconds: 60 },
          { actor: "manager", trigger_after_seconds: 7200 },
        ],
      });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(reviews).where(eq(reviews.id, res.body.id));
    expect(row.ladder_index).toBe(0);
    // ladder_next_promote_at must be the server-computed value, not the
    // attacker-supplied 2020 timestamp.
    const expectedAt = new Date(row.created_at.getTime() + 7200 * 1000);
    expect(row.ladder_next_promote_at?.toISOString()).toBe(expectedAt.toISOString());
  });
});

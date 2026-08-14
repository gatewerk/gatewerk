import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, reviews as reviewsTable } from "@gatewerk/db/src/schema/index";
import { generateId, ALL_SCOPES } from "@gatewerk/shared";
import { createReviewService } from "../services/reviews";
import { createReviewCrudRoutes } from "../routes/reviews/crud";
import { errorHandler } from "../middleware/error-handler";

describe("Review idempotency_key", () => {
  let app: any;
  let apiKey: string;
  let db: any;
  let projectId: string;
  let templateId: string;

  beforeAll(async () => {
    const result = await createTestDb();
    db = result.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    templateId = generateId("template");
    await db.insert(templates).values({
      id: templateId,
      slug: "idem-template",
      project_id: seed.project.id,
      name: "Idempotency Test Template",
      fields: [{ name: "content", type: "text", label: "Content", editable: true }],
      actions: ["approve", "reject"],
    });

    app = createApp({ db });
  });

  // Builds a faithful POST /reviews app whose injected service.create
  // simulates the concurrent winner: it commits a review row carrying the
  // request's idempotency_key (as a racer would between our fast-path SELECT
  // and our INSERT), then throws the unique-violation the partial index raises.
  // This deterministically drives the route's 23505 catch path on PGlite, which
  // is single-connection and cannot truly race two INSERTs in-process.
  // `winnerStatus` lets the same harness prove both the non-terminal (200) and
  // terminal (409) resolutions.
  //
  // The error must be thrown in the shape the route ACTUALLY receives, i.e.
  // wrapped in drizzle's DrizzleQueryError with the Postgres fields on
  // `.cause`. This fixture used to set `err.code` / `err.constraint` directly,
  // which no drizzle version has produced since the 0.44 wrapping change — so
  // (e) and (f) below were green in CI for a route that returned 500 in
  // production. See lib/pg-error.ts and pg-error.test.ts.
  function buildRaceApp(winnerStatus: string): { app: express.Express; winnerId: string } {
    const winnerId = generateId("review");
    const realService = createReviewService(db);
    const racingService = {
      ...realService,
      async create(pid: string, data: any) {
        await db.insert(reviewsTable).values({
          id: winnerId,
          project_id: pid,
          template_id: templateId,
          template_slug: "idem-template",
          payload: data.payload,
          idempotency_key: data.idempotency_key,
          status: winnerStatus,
        });
        const driverError: any = new Error(
          'duplicate key value violates unique constraint "reviews_project_id_idempotency_key_idx"',
        );
        driverError.code = "23505";
        driverError.constraint = "reviews_project_id_idempotency_key_idx";
        const wrapped: any = new Error("Failed query: insert into \"reviews\" ...");
        wrapped.cause = driverError;
        throw wrapped;
      },
    };
    const raceApp = express();
    raceApp.use(express.json());
    raceApp.use((req: any, _res, next) => {
      req.authType = "apikey";
      req.projectId = projectId;
      req.scopes = [...ALL_SCOPES];
      next();
    });
    raceApp.use("/api/v1/reviews", createReviewCrudRoutes({ db, service: racingService } as any));
    raceApp.use(errorHandler);
    return { app: raceApp, winnerId };
  }

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  it("(a) first create with idempotency_key → 201", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "idem-template",
        payload: { content: "hello" },
        idempotency_key: "test-key-001",
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  it("(b) duplicate idempotency_key with non-terminal existing review → 200 + same id", async () => {
    const key = "test-key-002";

    const first = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "idem-template",
        payload: { content: "hello" },
        idempotency_key: key,
      });
    expect(first.status).toBe(201);
    const firstId = first.body.id;

    const second = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "idem-template",
        payload: { content: "hello" },
        idempotency_key: key,
      });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(firstId);
  });

  it("(c) duplicate idempotency_key with terminal existing review → 409 idempotency_key_terminal_conflict", async () => {
    const key = "test-key-003-terminal";

    const first = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "idem-template",
        payload: { content: "to-be-decided" },
        idempotency_key: key,
      });
    expect(first.status).toBe(201);
    const reviewId = first.body.id;

    // Manually mark the review as decided (terminal)
    const { reviews: reviewsTable } = await import("@gatewerk/db/src/schema/index");
    const { eq } = await import("drizzle-orm");
    await db.update(reviewsTable).set({ status: "decided", decision: "approved" }).where(eq(reviewsTable.id, reviewId));

    const second = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "idem-template",
        payload: { content: "to-be-decided" },
        idempotency_key: key,
      });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("idempotency_key_terminal_conflict");
  });

  it("(d) no idempotency_key → two independent reviews created", async () => {
    const first = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "idem-template",
        payload: { content: "no key" },
      });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "idem-template",
        payload: { content: "no key" },
      });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });

  it("(e) 23505 on the idempotency index (lost race, non-terminal winner) → 200 with winner id, not 500", async () => {
    const { app: raceApp, winnerId } = buildRaceApp("pending");
    const res = await request(raceApp)
      .post("/api/v1/reviews")
      .send({
        template: "idem-template",
        payload: { content: "raced" },
        idempotency_key: "race-key-nonterminal",
      });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(winnerId);
  });

  it("(f) 23505 on the idempotency index (lost race, terminal winner) → 409 idempotency_key_terminal_conflict, not 500", async () => {
    const { app: raceApp } = buildRaceApp("decided");
    const res = await request(raceApp)
      .post("/api/v1/reviews")
      .send({
        template: "idem-template",
        payload: { content: "raced-terminal" },
        idempotency_key: "race-key-terminal",
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("idempotency_key_terminal_conflict");
  });
});

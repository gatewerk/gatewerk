import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import { errorHandler } from "../middleware/error-handler";

describe("Error handler message leak prevention", () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();

    app.get("/throw-400", (_req, _res, next) => {
      const err: any = new Error("sensitive: column users.ssn does not exist");
      err.status = 400;
      next(err);
    });

    app.get("/throw-500", (_req, _res, next) => {
      next(new Error("ECONNREFUSED 127.0.0.1:5432"));
    });

    app.get("/throw-422", (_req, _res, next) => {
      const err: any = new Error("file /app/packages/db/src/schema leaked");
      err.statusCode = 422;
      next(err);
    });

    app.use(errorHandler);
  });

  it("returns generic status text for non-500 non-GatewerkError", async () => {
    const res = await request(app).get("/throw-400");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Bad Request");
    expect(res.body.error.message).not.toContain("sensitive");
  });

  it("returns 'Something went wrong' for 500 errors", async () => {
    const res = await request(app).get("/throw-500");
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("Something went wrong");
    expect(res.body.error.message).not.toContain("ECONNREFUSED");
  });

  it("returns generic status text for 422 errors", async () => {
    const res = await request(app).get("/throw-422");
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe("Unprocessable Entity");
    expect(res.body.error.message).not.toContain("leaked");
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { GatewerkError } from "@gatewerk/shared";
import { errorHandler, _setReportErrorForTest } from "../middleware/error-handler";

describe("Sentry gate: expected errors never report", () => {
  const report = vi.fn();
  let app: express.Express;

  beforeEach(() => {
    report.mockClear();
    _setReportErrorForTest(report);
    app = express();
    app.get("/totp-not-configured", (_req, _res, next) =>
      next(new GatewerkError("TOTP is not configured on this instance", 501, "not_implemented", "not_implemented")),
    );
    app.get("/boom", (_req, _res, next) =>
      next(new GatewerkError("Storage error", 500, "internal_error", "storage_error")),
    );
    app.get("/plain-crash", (_req, _res, next) => next(new Error("ECONNREFUSED")));
    app.get("/bad-json", (_req, _res, next) => {
      const err = new SyntaxError("Unexpected token") as Error & { status?: number; type?: string };
      err.status = 400;
      err.type = "entity.parse.failed";
      next(err);
    });
    app.get("/too-large", (_req, _res, next) => {
      const err = new Error("request entity too large") as Error & { status?: number };
      err.status = 413;
      next(err);
    });
    app.use(errorHandler);
  });

  afterEach(() => {
    _setReportErrorForTest(null);
  });

  it("expected 501 GatewerkError does not reach Sentry", async () => {
    const res = await request(app).get("/totp-not-configured");
    expect(res.status).toBe(501);
    expect(report).not.toHaveBeenCalled();
  });

  it("500 GatewerkError still reports", async () => {
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("non-GatewerkError still reports", async () => {
    const res = await request(app).get("/plain-crash");
    expect(res.status).toBe(500);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("SyntaxError with status 400 (malformed JSON body) does not reach Sentry", async () => {
    const res = await request(app).get("/bad-json");
    expect(res.status).toBe(400);
    expect(report).not.toHaveBeenCalled();
  });

  it("413 payload too large does not reach Sentry", async () => {
    const res = await request(app).get("/too-large");
    expect(res.status).toBe(413);
    expect(report).not.toHaveBeenCalled();
  });
});

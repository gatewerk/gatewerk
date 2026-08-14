import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app";

describe("Health Check", () => {
  const app = createApp();

  it("GET /health returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /api/v1 returns 200 with version info", async () => {
    const res = await request(app).get("/api/v1");
    expect(res.status).toBe(200);
    expect(res.body.version).toBe("1");
    expect(res.body.protocol).toBe("HRP/1.0");
  });
});

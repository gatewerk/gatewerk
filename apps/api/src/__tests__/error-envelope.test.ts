import { describe, it, expect, vi } from "vitest";
import { requireRole } from "../middleware/require-role";
import { requireScope } from "../middleware/require-scope";

function run(mw: any, req: any) {
  const next = vi.fn();
  let sent: { status?: number; body?: any } = {};
  const res: any = {
    status(s: number) { sent.status = s; return this; },
    json(b: any) { sent.body = b; return this; },
  };
  mw(req, res, next);
  return { sent, next };
}

function expectEnvelope(body: any, type: string) {
  expect(body).toHaveProperty("error.type", type);
  expect(body).toHaveProperty("error.code");
  expect(body).toHaveProperty("error.message");
  expect(body).toHaveProperty("error.doc_url");
  // No legacy flat keys
  expect(body.message).toBeUndefined();
  expect(body.status).toBeUndefined();
  expect(typeof body.error).toBe("object");
}

describe("authz middleware error envelope", () => {
  it("requireRole 401 uses the canonical envelope via next(err)", () => {
    const { next } = run(requireRole("admin"), {});
    expect(next).toHaveBeenCalledOnce();
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(401);
    expectEnvelope(err.toJSON(), "authentication_error");
  });

  it("requireRole 403 uses the canonical envelope via next(err)", () => {
    const { next } = run(requireRole("admin"), { reviewer: { role: "reviewer" } });
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expectEnvelope(err.toJSON(), "forbidden");
    expect(err.message).toBe("This action requires one of these roles: admin");
  });

  it("requireScope 401/403 use the canonical envelope via next(err)", () => {
    const anon = run(requireScope("reviews:read"), {});
    expect(anon.next.mock.calls[0][0].statusCode).toBe(401);
    expectEnvelope(anon.next.mock.calls[0][0].toJSON(), "authentication_error");

    const denied = run(requireScope("reviews:read"), {
      authType: "apikey", projectId: "p1", scopes: [],
    });
    expect(denied.next.mock.calls[0][0].statusCode).toBe(403);
    expectEnvelope(denied.next.mock.calls[0][0].toJSON(), "forbidden");
    expect(denied.next.mock.calls[0][0].message).toBe("Missing required scope(s): reviews:read");
  });
});

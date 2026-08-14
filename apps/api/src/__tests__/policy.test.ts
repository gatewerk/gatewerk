import { describe, it, expect } from "vitest";
import { can, isAdminSession, isAdminSubject, isPrivilegedChainViewer } from "../policy";

describe("policy.can — api_key subjects", () => {
  it("allows when all required scopes are granted", () => {
    const d = can(
      { kind: "api_key", projectId: "p1", scopes: ["reviews:read", "reviews:decide"] },
      ["reviews:read"],
    );
    expect(d.allow).toBe(true);
  });

  it("denies when a required scope is missing", () => {
    const d = can(
      { kind: "api_key", projectId: "p1", scopes: ["reviews:read"] },
      ["templates:write"],
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("missing-scope");
  });

  it("ALL_SCOPES-bearing keys allow every required scope", () => {
    // Migration 020 removed the "null scopes = grandfather-allow" branch.
    // Legacy NULL-scope rows were backfilled with an explicit ALL_SCOPES
    // array preserving their de-facto full access. This test locks in the
    // equivalent post-migration behavior.
    const allScopes = [
      "reviews:create",
      "reviews:read",
      "reviews:decide",
      "templates:read",
      "templates:write",
      "feedback:read",
      "audit:read",
      "stats:read",
    ] as const;
    const d = can({ kind: "api_key", projectId: "p1", scopes: [...allScopes] }, ["templates:write"]);
    expect(d.allow).toBe(true);
  });
});

describe("policy.can — session subjects", () => {
  it("admin has every scope by construction", () => {
    const allScopes = [
      "reviews:create",
      "reviews:read",
      "reviews:decide",
      "templates:read",
      "templates:write",
      "feedback:read",
      "audit:read",
      "stats:read",
    ] as const;
    for (const s of allScopes) {
      const d = can({ kind: "session", userId: "u1", role: "admin" }, [s]);
      expect(d.allow).toBe(true);
    }
  });

  it("reviewer can read reviews and decide", () => {
    expect(can({ kind: "session", userId: "u1", role: "reviewer" }, ["reviews:read"]).allow).toBe(true);
    expect(can({ kind: "session", userId: "u1", role: "reviewer" }, ["reviews:decide"]).allow).toBe(true);
    expect(can({ kind: "session", userId: "u1", role: "reviewer" }, ["templates:read"]).allow).toBe(true);
    expect(can({ kind: "session", userId: "u1", role: "reviewer" }, ["stats:read"]).allow).toBe(true);
  });

  it("reviewer cannot write templates (blocks the bypass)", () => {
    const d = can({ kind: "session", userId: "u1", role: "reviewer" }, ["templates:write"]);
    expect(d.allow).toBe(false);
  });

  it("reviewer cannot create reviews (blocks the bypass)", () => {
    const d = can({ kind: "session", userId: "u1", role: "reviewer" }, ["reviews:create"]);
    expect(d.allow).toBe(false);
  });

  it("reviewer cannot read audit log", () => {
    const d = can({ kind: "session", userId: "u1", role: "reviewer" }, ["audit:read"]);
    expect(d.allow).toBe(false);
  });

  it("unknown role fails closed", () => {
    const d = can({ kind: "session", userId: "u1", role: "intern" }, ["reviews:read"]);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("unknown-role");
  });
});

describe("policy.isAdminSubject", () => {
  it("true only for a session subject with role admin", () => {
    expect(isAdminSubject({ kind: "session", userId: "u1", role: "admin" })).toBe(true);
    expect(isAdminSubject({ kind: "session", userId: "u1", role: "reviewer" })).toBe(false);
  });

  it("false for api_key subjects even if a role property is present", () => {
    const key = { kind: "api_key", projectId: "p1", scopes: [], role: "admin" } as any;
    expect(isAdminSubject(key)).toBe(false);
  });
});

describe("policy.isAdminSession", () => {
  it("true only for session auth with an admin reviewer", () => {
    expect(isAdminSession({ authType: "session", reviewer: { role: "admin" } })).toBe(true);
    expect(isAdminSession({ authType: "session", reviewer: { role: "reviewer" } })).toBe(false);
    expect(isAdminSession({ authType: "apikey", reviewer: { role: "admin" } })).toBe(false);
    expect(isAdminSession({ authType: "session" })).toBe(false);
  });
});

describe("policy.isPrivilegedChainViewer", () => {
  const owner = "user_abc";

  it("false for non-session auth regardless of role", () => {
    expect(isPrivilegedChainViewer({ authType: "apikey", reviewer: { role: "admin" } }, owner)).toBe(false);
  });

  it("true for an admin session", () => {
    expect(isPrivilegedChainViewer(
      { authType: "session", reviewer: { role: "admin", email: "x@y.z" }, userId: "someone_else" },
      owner,
    )).toBe(true);
  });

  it("true when req.userId matches the chain owner id", () => {
    expect(isPrivilegedChainViewer(
      { authType: "session", reviewer: { role: "reviewer", email: "x@y.z" }, userId: "user_abc" },
      owner,
    )).toBe(true);
  });

  it("true when reviewer:<email> matches the owner (chains.ts creator format)", () => {
    expect(isPrivilegedChainViewer(
      { authType: "session", reviewer: { role: "reviewer", email: "x@y.z" }, userId: "u9" },
      "reviewer:x@y.z",
    )).toBe(true);
  });

  it("true when the bare email matches the owner", () => {
    expect(isPrivilegedChainViewer(
      { authType: "session", reviewer: { role: "reviewer", email: "x@y.z" }, userId: "u9" },
      "x@y.z",
    )).toBe(true);
  });

  it("false for an unrelated reviewer session", () => {
    expect(isPrivilegedChainViewer(
      { authType: "session", reviewer: { role: "reviewer", email: "other@y.z" }, userId: "u9" },
      owner,
    )).toBe(false);
  });

  it("false when userId is absent and owner is a userId", () => {
    expect(isPrivilegedChainViewer(
      { authType: "session", reviewer: { role: "reviewer", email: "x@y.z" } },
      owner,
    )).toBe(false);
  });
});

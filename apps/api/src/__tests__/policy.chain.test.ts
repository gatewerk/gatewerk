import { describe, it, expect } from "vitest";
import { SCOPES } from "@gatewerk/shared";
import { can, type Subject } from "../policy";

// M11 unit tests for can() chain_step arm. Pure; no DB. The decide-route
// integration layer is covered in decide-chain-policy.test.ts.
//
// Policy (spec §7 / user prompt): a chain-step subject resolves Allow iff
//   (a) requester is admin, OR
//   (b) requester is the chain owner, OR
//   (c) requester matches step_assignee.email (email variant), OR
//   (d) requester matches step_assignee.role (role variant)
// AND the requester has the required scope on the inner subject.

function sessionRequester(overrides: Partial<{ userId: string; email: string; role: string }> = {}) {
  return {
    kind: "session" as const,
    userId: overrides.userId ?? "user_alice",
    email: overrides.email ?? "alice@example.com",
    role: overrides.role ?? "reviewer",
  };
}

function apiKeyRequester() {
  return {
    kind: "api_key" as const,
    projectId: "proj_test",
    scopes: ["reviews:decide", "reviews:read"] as any,
  };
}

function chainStep(overrides: Partial<{
  review_id: string;
  chain_run_id: string;
  step_index: number;
  step_assignee: { kind: "email"; email: string } | { kind: "role"; role: string } | null;
  chain_owner_id: string;
  requester: ReturnType<typeof sessionRequester> | ReturnType<typeof apiKeyRequester>;
}> = {}): Subject {
  return {
    kind: "chain_step" as const,
    review_id: overrides.review_id ?? "gw_rev_001",
    chain_run_id: overrides.chain_run_id ?? "gw_chain_001",
    step_index: overrides.step_index ?? 1,
    step_assignee: overrides.step_assignee !== undefined
      ? overrides.step_assignee
      : { kind: "email", email: "alice@example.com" },
    chain_owner_id: overrides.chain_owner_id ?? "reviewer:owner@example.com",
    requester: overrides.requester ?? sessionRequester(),
  };
}

describe("policy.can — chain_step: allowed paths", () => {
  it("allows when session email matches step_assignee (email variant)", () => {
    const subject = chainStep({
      step_assignee: { kind: "email", email: "alice@example.com" },
      requester: sessionRequester({ email: "alice@example.com" }),
    });
    expect(can(subject, ["reviews:decide"]).allow).toBe(true);
  });

  it("allows when session role matches step_assignee (role variant)", () => {
    const subject = chainStep({
      step_assignee: { kind: "role", role: "admin" },
      requester: sessionRequester({ role: "admin" }),
    });
    expect(can(subject, ["reviews:decide"]).allow).toBe(true);
  });

  it("allows admin bypass even when email does not match", () => {
    const subject = chainStep({
      step_assignee: { kind: "email", email: "alice@example.com" },
      requester: sessionRequester({ role: "admin", email: "admin@example.com" }),
    });
    expect(can(subject, ["reviews:decide"]).allow).toBe(true);
  });

  it("allows chain owner when session userId matches chain_owner_id", () => {
    const subject = chainStep({
      step_assignee: { kind: "email", email: "someone_else@example.com" },
      chain_owner_id: "user_owner",
      requester: sessionRequester({ userId: "user_owner", email: "owner@example.com" }),
    });
    expect(can(subject, ["reviews:decide"]).allow).toBe(true);
  });

  it("allows chain owner when 'reviewer:<email>' prefix matches chain_owner_id", () => {
    // routes/chains.ts formats session-created chains' created_by as
    // "reviewer:<email>". Chain-owner matching must honor that format
    // without requiring the chain-aware layer to know about the prefix.
    const subject = chainStep({
      step_assignee: { kind: "email", email: "someone_else@example.com" },
      chain_owner_id: "reviewer:owner@example.com",
      requester: sessionRequester({ userId: "user_owner", email: "owner@example.com" }),
    });
    expect(can(subject, ["reviews:decide"]).allow).toBe(true);
  });

  it("allows admin bypass even when step_assignee is null (external_token step)", () => {
    const subject = chainStep({
      step_assignee: null,
      requester: sessionRequester({ role: "admin" }),
    });
    expect(can(subject, ["reviews:decide"]).allow).toBe(true);
  });
});

describe("policy.can — chain_step: denied paths", () => {
  it("denies a session reviewer whose email does not match and is not admin/owner", () => {
    const subject = chainStep({
      step_assignee: { kind: "email", email: "alice@example.com" },
      chain_owner_id: "reviewer:owner@example.com",
      requester: sessionRequester({
        userId: "user_bob",
        email: "bob@example.com",
        role: "reviewer",
      }),
    });
    const decision = can(subject, ["reviews:decide"]);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain("chain-step");
  });

  it("denies a session whose role does not match the step's role assignee", () => {
    const subject = chainStep({
      step_assignee: { kind: "role", role: "admin" },
      chain_owner_id: "reviewer:owner@example.com",
      requester: sessionRequester({ role: "reviewer" }),
    });
    expect(can(subject, ["reviews:decide"]).allow).toBe(false);
  });

  it("denies an api_key requester that is not admin/owner (machines can't decide chain steps)", () => {
    const subject = chainStep({
      step_assignee: { kind: "email", email: "alice@example.com" },
      chain_owner_id: "reviewer:owner@example.com",
      requester: apiKeyRequester(),
    });
    expect(can(subject, ["reviews:decide"]).allow).toBe(false);
  });

  it("denies when step_assignee is null and requester is not admin/owner", () => {
    const subject = chainStep({
      step_assignee: null,
      chain_owner_id: "reviewer:owner@example.com",
      requester: sessionRequester({ email: "not-owner@example.com", role: "reviewer" }),
    });
    expect(can(subject, ["reviews:decide"]).allow).toBe(false);
  });
});

describe("policy.can — chain_step: scope delegation", () => {
  it("denies when gate passes but requester lacks the required scope", () => {
    // Reviewer has reviews:decide but not templates:write. Gate passes
    // (email matches), scope check fails → overall deny with the scope reason.
    const subject = chainStep({
      step_assignee: { kind: "email", email: "alice@example.com" },
      requester: sessionRequester({ email: "alice@example.com", role: "reviewer" }),
    });
    const decision = can(subject, ["templates:write"]);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain("templates:write");
  });

  it("gate passes + scope passes → allow (compound success)", () => {
    const subject = chainStep({
      step_assignee: { kind: "email", email: "alice@example.com" },
      requester: sessionRequester({ email: "alice@example.com", role: "reviewer" }),
    });
    expect(can(subject, ["reviews:decide"]).allow).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Step 1: chains:create scope
// ────────────────────────────────────────────────────────────────
describe("chains:create scope", () => {
  it("SCOPES array includes chains:create", () => {
    expect((SCOPES as readonly string[]).includes("chains:create")).toBe(true);
  });

  it("session admin can use chains:create scope", () => {
    const session: Subject = { kind: "session", userId: "u_admin", role: "admin" };
    expect(can(session, ["chains:create"]).allow).toBe(true);
  });

  it("session reviewer cannot use chains:create scope", () => {
    const session: Subject = { kind: "session", userId: "u_reviewer", role: "reviewer" };
    expect(can(session, ["chains:create"]).allow).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Step 2: bypass tags in evaluateChainStep (threaded through can())
// ────────────────────────────────────────────────────────────────
describe("chain_step: bypass tags", () => {
  it("admin requester → bypass='admin'", () => {
    const subject = chainStep({
      requester: sessionRequester({ role: "admin", email: "admin@example.com" }),
      step_assignee: { kind: "email", email: "someone_else@example.com" },
    });
    const decision = can(subject, ["reviews:decide"]);
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.bypass).toBe("admin");
  });

  it("owner (non-admin, email not assignee) → bypass='owner'", () => {
    const subject = chainStep({
      requester: sessionRequester({ userId: "owner_id", email: "owner@example.com", role: "reviewer" }),
      chain_owner_id: "owner_id",
      step_assignee: { kind: "email", email: "someone_else@example.com" },
    });
    const decision = can(subject, ["reviews:decide"]);
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.bypass).toBe("owner");
  });

  it("assignee match → no bypass (bypass is undefined)", () => {
    const subject = chainStep({
      requester: sessionRequester({ email: "alice@example.com", role: "reviewer" }),
      step_assignee: { kind: "email", email: "alice@example.com" },
    });
    const decision = can(subject, ["reviews:decide"]);
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.bypass).toBeUndefined();
  });

  it("role-match assignee → no bypass", () => {
    const subject = chainStep({
      requester: sessionRequester({ role: "reviewer" }),
      step_assignee: { kind: "role", role: "reviewer" },
    });
    const decision = can(subject, ["reviews:decide"]);
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.bypass).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Step 3: fail-closed gate — sentinel chain_owner_id
// ────────────────────────────────────────────────────────────────
describe("chain_step: fail-closed sentinel (context unavailable)", () => {
  it("sentinel owner + null assignee denies a reviewer", () => {
    const subject = chainStep({
      chain_owner_id: "\x00chain_context_unavailable",
      step_assignee: null,
      requester: sessionRequester({ role: "reviewer", email: "alice@example.com" }),
    });
    const decision = can(subject, ["reviews:decide"]);
    expect(decision.allow).toBe(false);
  });

  it("sentinel owner + null assignee still allows admin (admin bypass remains)", () => {
    const subject = chainStep({
      chain_owner_id: "\x00chain_context_unavailable",
      step_assignee: null,
      requester: sessionRequester({ role: "admin", email: "admin@example.com" }),
    });
    const decision = can(subject, ["reviews:decide"]);
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.bypass).toBe("admin");
  });
});

describe("policy.can — chain_step: non-chain subjects unaffected", () => {
  it("base session subject behavior is unchanged by the chain_step arm", () => {
    // Sanity: plain sessions keep the existing can() semantics — this is
    // the critical compatibility guarantee for non-chain review flows.
    const session: Subject = { kind: "session", userId: "u1", role: "reviewer" };
    expect(can(session, ["reviews:decide"]).allow).toBe(true);
    expect(can(session, ["templates:write"]).allow).toBe(false);
  });

  it("base api_key subject behavior is unchanged by the chain_step arm", () => {
    const apiKey: Subject = { kind: "api_key", projectId: "p", scopes: ["reviews:decide"] };
    expect(can(apiKey, ["reviews:decide"]).allow).toBe(true);
    expect(can(apiKey, ["templates:write"]).allow).toBe(false);
  });
});

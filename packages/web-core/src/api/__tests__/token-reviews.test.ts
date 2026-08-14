import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateToken } from "../token-reviews";
import { ApiError } from "../client/http";

/**
 * validateToken() is the API → discriminated-union mapper. The wire
 * shape carries optional flags (requires_email_otp, cookie_invalid,
 * decision, message) that consumers should not have to defend against;
 * these tests lock the mapping so each consumer render branch can rely
 * on exhaustive (status, kind) narrowing.
 */

const originalFetch = globalThis.fetch;

// Vitest config defaults to the node environment for this file; node has
// no sessionStorage / localStorage. validateToken now reads getToken() so
// it can attach Authorization for account-tier tokens — stub a minimal
// in-memory Storage so the mapper does not throw on `localStorage.getItem`
// while still exercising the loose-flag branches the suite covers.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

// Force-replace — Node 22 LTS exposes stub `localStorage` / `sessionStorage`
// globals without functional methods, so a typeof-undefined guard is not
// sufficient.
(globalThis as unknown as Record<string, unknown>).sessionStorage = new MemoryStorage();
(globalThis as unknown as Record<string, unknown>).localStorage = new MemoryStorage();

function mockFetchOnce(opts: {
  status: number;
  body: unknown;
  ok?: boolean;
}) {
  const ok = opts.ok ?? (opts.status >= 200 && opts.status < 300);
  globalThis.fetch = vi.fn().mockResolvedValueOnce({
    status: opts.status,
    ok,
    text: async () =>
      opts.body === undefined ? "" : JSON.stringify(opts.body),
    json: async () => opts.body,
    headers: new Headers(),
    statusText: "",
  } as unknown as Response);
}

function mockFetchOnceMalformed() {
  // Mapper now reads via res.text() then JSON.parse — return a non-JSON
  // string so the JSON.parse throws and the explicit catch wraps it.
  globalThis.fetch = vi.fn().mockResolvedValueOnce({
    status: 200,
    ok: true,
    text: async () => "<html>oops</html>",
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
    headers: new Headers(),
    statusText: "OK",
  } as unknown as Response);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("validateToken mapper", () => {
  it("M1: 200 with review + template maps to {status:valid, kind:ready}", async () => {
    mockFetchOnce({
      status: 200,
      body: {
        status: "valid",
        review: {
          id: "review_1",
          payload: { foo: "bar" },
          priority: "normal",
          actions: ["approve", "reject"],
          template_slug: "demo",
          created_at: "2026-05-09T00:00:00Z",
        },
        template: {
          name: "Demo",
          fields: [],
          actions: [],
        },
      },
    });
    const result = await validateToken("gw_tok_x");
    expect(result.status).toBe("valid");
    if (result.status === "valid" && result.kind === "ready") {
      expect(result.review.id).toBe("review_1");
      expect(result.template?.name).toBe("Demo");
    } else {
      throw new Error("expected kind:ready");
    }
  });

  it("M2: 200 with requires_email_otp:true maps to {status:valid, kind:needs_otp}", async () => {
    mockFetchOnce({
      status: 200,
      body: {
        status: "valid",
        requires_email_otp: true,
        recipient_email_hint: "a***@example.com",
      },
    });
    const result = await validateToken("gw_tok_x");
    if (result.status === "valid" && result.kind === "needs_otp") {
      expect(result.recipient_email_hint).toBe("a***@example.com");
      expect(result.cookie_invalid).toBeUndefined();
    } else {
      throw new Error("expected kind:needs_otp");
    }
  });

  it("M3: M2 + cookie_invalid:true preserves the cookie_invalid flag", async () => {
    mockFetchOnce({
      status: 200,
      body: {
        status: "valid",
        requires_email_otp: true,
        recipient_email_hint: "b***@example.com",
        cookie_invalid: true,
      },
    });
    const result = await validateToken("gw_tok_x");
    if (result.status === "valid" && result.kind === "needs_otp") {
      expect(result.cookie_invalid).toBe(true);
    } else {
      throw new Error("expected kind:needs_otp");
    }
  });

  it("M4: 410 with status:used maps to {status:used, decision, decided_at, message}", async () => {
    mockFetchOnce({
      status: 410,
      body: {
        status: "used",
        decision: "approved",
        decided_at: "2026-05-08T12:00:00Z",
        message: "Already decided",
      },
    });
    const result = await validateToken("gw_tok_x");
    if (result.status === "used") {
      expect(result.decision).toBe("approved");
      expect(result.decided_at).toBe("2026-05-08T12:00:00Z");
      expect(result.message).toBe("Already decided");
    } else {
      throw new Error("expected status:used");
    }
  });

  it("M5: 410 with status:expired maps to {status:expired, message}", async () => {
    mockFetchOnce({
      status: 410,
      body: { status: "expired", message: "Link has expired" },
    });
    const result = await validateToken("gw_tok_x");
    if (result.status === "expired") {
      expect(result.message).toBe("Link has expired");
    } else {
      throw new Error("expected status:expired");
    }
  });

  it("M6: 404 throws ApiError with status 404", async () => {
    mockFetchOnce({
      status: 404,
      body: { error: { message: "Token not found", code: "not_found" } },
    });
    await expect(validateToken("gw_tok_x")).rejects.toThrow(ApiError);
    mockFetchOnce({
      status: 404,
      body: { error: { message: "Token not found", code: "not_found" } },
    });
    try {
      await validateToken("gw_tok_x");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
      expect((err as ApiError).code).toBe("not_found");
    }
  });

  it("M7: 5xx throws ApiError with status preserved", async () => {
    mockFetchOnce({
      status: 503,
      body: { error: { message: "Database down" } },
    });
    try {
      await validateToken("gw_tok_x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(503);
      expect((err as ApiError).message).toBe("Database down");
    }
  });

  it("M8: malformed JSON on a 200 response surfaces as ApiError, not an unhandled SyntaxError", async () => {
    // RFC 7159 — a 200 with non-JSON body is a server protocol violation.
    // The mapper must surface ApiError so consumers can route to a
    // diagnostic state rather than fall through to kind:"ready" with an
    // empty body (which then crashes deeper at review.payload access).
    mockFetchOnceMalformed();
    await expect(validateToken("gw_tok_x")).rejects.toThrow(ApiError);
    mockFetchOnceMalformed();
    await expect(validateToken("gw_tok_x")).rejects.toMatchObject({
      status: 200,
      message: expect.stringMatching(/malformed/i),
    });
  });

  it("M9: null body throws ApiError instead of TypeError on .requires_email_otp", async () => {
    // Defense against a server that returns the string "null" on a 200.
    // Without the non-object guard, body.requires_email_otp would TypeError.
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => "null",
      headers: new Headers(),
      statusText: "OK",
    } as unknown as Response);
    await expect(validateToken("gw_tok_x")).rejects.toThrow(ApiError);
  });

  it("M11: 200 with requires_account_login:true maps to {status:valid, kind:needs_login}", async () => {
    // Account-bound recipient flow (token redesign §6.2). Server omits
    // review/template when the visitor is not logged into Gatewerk; the
    // mapper surfaces a discrete `needs_login` kind so the consumer
    // narrows correctly and routes to the sign-in CTA without being
    // tempted to read review.payload off undefined.
    mockFetchOnce({
      status: 200,
      body: { status: "valid", requires_account_login: true },
    });
    const result = await validateToken("gw_tok_x");
    expect(result).toEqual({ status: "valid", kind: "needs_login" });
    // Field-leak pinning — needs_login carries no auxiliary fields the
    // server may have echoed back; ensure the mapper does not pass any
    // sibling flag through.
    expect(result).not.toHaveProperty("recipient_email_hint");
    expect(result).not.toHaveProperty("current_account_label");
  });

  it("M12: 200 with account_mismatch:true maps to {status:valid, kind:account_mismatch}", async () => {
    // E15 (account mismatch) — recipient is logged in as a user that does
    // NOT match the token's auth_user_id. Server returns the current
    // logged-in label only; expected_account_label is intentionally
    // omitted server-side (recipient PII protection). Mapper preserves
    // the label and exposes a typed branch consumers can render the
    // switch-accounts CTA against.
    mockFetchOnce({
      status: 200,
      body: {
        status: "valid",
        account_mismatch: true,
        current_account_label: "alice@example.com",
      },
    });
    const result = await validateToken("gw_tok_x");
    if (result.status === "valid" && result.kind === "account_mismatch") {
      expect(result.current_account_label).toBe("alice@example.com");
    } else {
      throw new Error("expected kind:account_mismatch");
    }
    // Field-leak pinning — account_mismatch carries only current_account_label;
    // ensure the mapper does not pass through hint or login flags.
    expect(result).not.toHaveProperty("recipient_email_hint");
    expect(result).not.toHaveProperty("requires_account_login");
  });

  it("M13: multiple auth-tier flags set → throws ApiError (server protocol violation)", async () => {
    // Mutual-exclusion guard: requires_email_otp / requires_account_login /
    // account_mismatch are disjoint server-side. Multiple flags set is a
    // protocol violation; surface as ApiError so consumers route to a
    // diagnostic state instead of silently picking first-match-wins.
    mockFetchOnce({
      status: 200,
      body: {
        status: "valid",
        requires_email_otp: true,
        requires_account_login: true,
      },
    });
    await expect(validateToken("gw_tok_x")).rejects.toThrow(ApiError);
    mockFetchOnce({
      status: 200,
      body: {
        status: "valid",
        requires_email_otp: true,
        requires_account_login: true,
      },
    });
    await expect(validateToken("gw_tok_x")).rejects.toMatchObject({
      message: expect.stringMatching(/conflicting/i),
    });
  });

  it("M10: requires_email_otp:false explicitly maps to kind:'ready'", async () => {
    // The negative branch: an explicit false flag must NOT be confused
    // with the omitted-flag path. Both should land in kind:ready, but the
    // narrowing exercised here pins the boolean handling shape.
    mockFetchOnce({
      status: 200,
      body: {
        status: "valid",
        requires_email_otp: false,
        review: {
          id: "review_m10",
          payload: { x: 1 },
          priority: "normal",
          actions: ["approve"],
          template_slug: "demo",
          created_at: "2026-05-09T00:00:00Z",
        },
        template: { name: "Demo", fields: [], actions: [] },
      },
    });
    const result = await validateToken("gw_tok_x");
    if (result.status === "valid" && result.kind === "ready") {
      expect(result.review.id).toBe("review_m10");
    } else {
      throw new Error("expected kind:ready");
    }
  });
});

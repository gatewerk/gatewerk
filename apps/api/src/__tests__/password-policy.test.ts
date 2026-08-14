import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validatePassword } from "../lib/password-policy";

describe("Password policy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects passwords shorter than 12 characters", async () => {
    const result = await validatePassword("short");
    expect(result.valid).toBe(false);
    expect(result.code).toBe("too_short");
  });

  it("rejects passwords longer than 128 characters", async () => {
    const result = await validatePassword("a".repeat(129));
    expect(result.valid).toBe(false);
    expect(result.code).toBe("too_long");
  });

  it("accepts a valid 12-character password", async () => {
    vi.stubEnv("SKIP_HIBP", "");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("AABBCCDD:0\nEEFFGGHH:0", { status: 200 }),
    );
    const result = await validatePassword("validpassword1");
    expect(result.valid).toBe(true);
  });

  it("rejects a breached password", async () => {
    vi.stubEnv("SKIP_HIBP", "");
    // SHA1("password123456").slice(5) — suffix used by checkHibp against the mock response
    const suffix = "C09B0759E63EF7DF53592724E8EEDDB953A";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(`${suffix}:9876543\nOTHERHASH:123`, { status: 200 }),
    );
    const result = await validatePassword("password123456");
    expect(result.valid).toBe(false);
    expect(result.code).toBe("breached");
  });

  it("allows password when HIBP API is unreachable (fail-open)", async () => {
    vi.stubEnv("SKIP_HIBP", "");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));
    const result = await validatePassword("validpassword123");
    expect(result.valid).toBe(true);
  });

  it("allows password when HIBP API times out (fail-open)", async () => {
    vi.stubEnv("SKIP_HIBP", "");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 100)),
    );
    const result = await validatePassword("validpassword123");
    expect(result.valid).toBe(true);
  });

  it("does not impose composition rules (accepts all-lowercase)", async () => {
    vi.stubEnv("SKIP_HIBP", "");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("NOMATCHES:0", { status: 200 }),
    );
    const result = await validatePassword("alllowercase");
    expect(result.valid).toBe(true);
  });

  it("accepts unicode passwords", async () => {
    vi.stubEnv("SKIP_HIBP", "");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("NOMATCHES:0", { status: 200 }),
    );
    const result = await validatePassword("пароль安全なパスワード");
    expect(result.valid).toBe(true);
  });
});

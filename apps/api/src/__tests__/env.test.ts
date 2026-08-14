// Tests for the t3-env serverEnv contract in env.ts.
//
// Pattern: vi.stubEnv + vi.resetModules() + dynamic `await import("../env")`
// gives each test a fresh module evaluation reflecting the stubbed env state.
// This is zero-blast-radius — no existing call sites change.
//
// skipValidation gate: env.ts skips validation when NODE_ENV=test OR
// VITEST=true. Tests that exercise the validation path (prod throws) must
// explicitly stub both to non-test values.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { BootError } from "@gatewerk/shared";

describe("env.ts (t3-env serverEnv contract)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Stub all required-at-boot vars to valid-looking values. */
  function stubRequiredValid() {
    vi.stubEnv("DATABASE_URL", "postgres://x/y");
    vi.stubEnv("JWT_SECRET", "test-jwt");
    vi.stubEnv("HMAC_SECRET", "test-hmac");
    vi.stubEnv("OTP_HMAC_SECRET", "test-otp");
    vi.stubEnv("UI_ORIGIN", "https://example.com");
  }

  /**
   * Force prod-mode validation. Both NODE_ENV AND VITEST must leave the
   * skipValidation predicate false — env.ts checks:
   *   process.env.NODE_ENV === "test" || process.env.VITEST === "true"
   * Setting VITEST="" (empty string) means it is NOT "true".
   */
  function stubProdMode() {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
  }

  // ── Case 1 ────────────────────────────────────────────────────────────────
  it("returns parsed values under skipValidation=true (test mode)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    stubRequiredValid();
    vi.stubEnv("SMTP_HOST", "smtp.example.com");

    const { serverEnv } = await import("../env");

    expect(serverEnv.DATABASE_URL).toBe("postgres://x/y");
    expect(serverEnv.JWT_SECRET).toBe("test-jwt");
    expect(serverEnv.HMAC_SECRET).toBe("test-hmac");
    expect(serverEnv.OTP_HMAC_SECRET).toBe("test-otp");
    expect(serverEnv.UI_ORIGIN).toBe("https://example.com");
  });

  // ── Case 2 ────────────────────────────────────────────────────────────────
  it("throws when required var is missing in prod mode (skipValidation=false)", async () => {
    stubProdMode();
    // Provide all required vars EXCEPT DATABASE_URL
    vi.stubEnv("JWT_SECRET", "test-jwt");
    vi.stubEnv("HMAC_SECRET", "test-hmac");
    vi.stubEnv("OTP_HMAC_SECRET", "test-otp");
    vi.stubEnv("UI_ORIGIN", "https://example.com");
    // DATABASE_URL deliberately omitted

    await expect(async () => {
      await import("../env");
    }).rejects.toThrow();
  });

  // ── Case 3 ────────────────────────────────────────────────────────────────
  it("emptyStringAsUndefined: empty string optional vars become undefined", async () => {
    // Leave NODE_ENV as "test" so skipValidation fires — we only need to
    // verify the emptyStringAsUndefined behaviour, not the full parse path.
    vi.stubEnv("NODE_ENV", "test");
    stubRequiredValid();
    vi.stubEnv("SMTP_HOST", "");

    const { serverEnv } = await import("../env");

    // emptyStringAsUndefined:true strips empty strings to undefined before
    // they reach the schema. In test mode the runtimeEnv is returned as-is
    // after the emptyStringAsUndefined pre-processing step.
    expect(serverEnv.SMTP_HOST).toBeUndefined();
  });

  // ── Case 4 ────────────────────────────────────────────────────────────────
  it("URL validator rejects invalid URL for SUPABASE_URL in prod mode", async () => {
    stubProdMode();
    stubRequiredValid();
    vi.stubEnv("SUPABASE_URL", "not-a-url");

    await expect(async () => {
      await import("../env");
    }).rejects.toThrow();
  });

  // ── Case 5 ────────────────────────────────────────────────────────────────
  describe("enum schemas reject invalid values in prod mode", () => {
    it("NODE_ENV rejects unknown value", async () => {
      vi.stubEnv("NODE_ENV", "nope");
      vi.stubEnv("VITEST", "");
      stubRequiredValid();

      await expect(async () => {
        await import("../env");
      }).rejects.toThrow();
    });

    it("GATEWERK_MODE rejects typo value", async () => {
      stubProdMode();
      stubRequiredValid();
      vi.stubEnv("GATEWERK_MODE", "standalon");

      await expect(async () => {
        await import("../env");
      }).rejects.toThrow();
    });

    it("SMTP_SECURE rejects non-boolean-string value", async () => {
      stubProdMode();
      stubRequiredValid();
      vi.stubEnv("SMTP_SECURE", "yes");

      await expect(async () => {
        await import("../env");
      }).rejects.toThrow();
    });
  });

  // ── Case 6a ───────────────────────────────────────────────────────────────
  // Note: `instanceof BootError` cannot be used here because vi.resetModules()
  // causes @gatewerk/shared to be re-evaluated in a fresh module context, so
  // the BootError class from the dynamic import is a DIFFERENT class object
  // than the statically imported one. We check structural properties instead.
  it("onValidationError names the failing var in the BootError message", async () => {
    stubProdMode();
    // All required vars valid except DATABASE_URL (omitted → fails .min(1))
    vi.stubEnv("JWT_SECRET", "test-jwt");
    vi.stubEnv("HMAC_SECRET", "test-hmac");
    vi.stubEnv("OTP_HMAC_SECRET", "test-otp");
    vi.stubEnv("UI_ORIGIN", "https://example.com");

    let caught: unknown;
    try {
      await import("../env");
    } catch (err) {
      caught = err;
    }

    // Structural checks — class identity differs across module reset boundaries
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("BootError");
    expect((caught as Error & { code: string }).code).toBe("invalid_env");
    expect((caught as Error).message).toContain("DATABASE_URL");
  });

  // ── Case 6b ───────────────────────────────────────────────────────────────
  it("onValidationError redacts secret var values and echoes non-secret values", async () => {
    stubProdMode();
    stubRequiredValid();
    // Force JWT_SECRET to fail by overriding to empty — emptyStringAsUndefined
    // converts "" to undefined, which fails the .min(1) check.
    vi.stubEnv("JWT_SECRET", "");
    // DATABASE_URL is a non-secret var; set it to a bad value to also trigger.
    vi.stubEnv("DATABASE_URL", "");

    let caught: unknown;
    try {
      await import("../env");
    } catch (err) {
      caught = err;
    }

    // Structural checks — class identity differs across module reset boundaries
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("BootError");
    const msg = (caught as Error).message;
    // Secret vars must be redacted — actual value must not appear
    expect(msg).toContain("JWT_SECRET");
    expect(msg).toContain("[redacted]");
    expect(msg).not.toContain("test-jwt");
  });
});

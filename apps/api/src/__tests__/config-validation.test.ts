import { describe, it, expect, afterEach, vi } from "vitest";
import { requireEnv, validateProductionConfig } from "../config";
import { BootError } from "@gatewerk/shared";

/**
 * Returns the `code` of the BootError thrown by `fn`, or fails.
 *
 * All three insecure-secret guards in `validateProductionConfig` throw a
 * message containing the substring "insecure default", and `toThrow(string)`
 * is a substring match — so the original `toThrow("insecure default")`
 * assertions could not tell which guard fired. Mutation-tested: with the JWT
 * guard deleted, the OTP guard threw a matching message and the JWT test
 * stayed green; likewise for HMAC; likewise with both deleted. Only deleting
 * all three turned them red. Asserting the stable `code` pins each test to
 * its own guard, matching what the `requireEnv` block below already does at
 * :155/:175.
 */
function bootErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof BootError) return err.code;
    throw err;
  }
  throw new Error("expected validateProductionConfig to throw a BootError, but it did not throw");
}

describe("validateProductionConfig", () => {
  it("throws if jwtSecret is the dev default in production", () => {
    expect(
      bootErrorCode(() =>
        validateProductionConfig({
          jwtSecret: "dev-jwt-secret",
          hmacSecret: "real-secret-here",
        })
      )
    ).toBe("insecure_jwt_secret");
  });

  it("throws if hmacSecret is the dev default in production", () => {
    expect(
      bootErrorCode(() =>
        validateProductionConfig({
          jwtSecret: "real-secret-here",
          hmacSecret: "dev-secret",
        })
      )
    ).toBe("insecure_hmac_secret");
  });

  it("does not throw with real secrets", () => {
    expect(() =>
      validateProductionConfig({
        jwtSecret: "a-real-production-jwt-secret",
        hmacSecret: "a-real-production-hmac-secret",
        otpHmacSecret: "a-real-production-otp-hmac-secret",
        uiOrigin: "https://app.gatewerk.com",
      })
    ).not.toThrow();
  });

  it("throws if otpHmacSecret is the test fallback in production", () => {
    expect(
      bootErrorCode(() =>
        validateProductionConfig({
          jwtSecret: "a-real-production-jwt-secret",
          hmacSecret: "a-real-production-hmac-secret",
          otpHmacSecret: "test-otp-hmac-secret-do-not-use-in-prod",
        })
      )
    ).toBe("insecure_otp_hmac_secret");
  });

  // H7 — CORS boot validation: UI_ORIGIN must be a single absolute URL
  const validSecrets = {
    jwtSecret: "a-real-production-jwt-secret",
    hmacSecret: "a-real-production-hmac-secret",
    otpHmacSecret: "a-real-production-otp-hmac-secret",
  };

  it("throws when UI_ORIGIN is wildcard '*'", () => {
    expect(() =>
      validateProductionConfig({ ...validSecrets, uiOrigin: "*" })
    ).toThrow("UI_ORIGIN must be a single absolute URL when credentials are enabled");
  });

  it("throws when UI_ORIGIN contains comma-separated origins", () => {
    expect(() =>
      validateProductionConfig({
        ...validSecrets,
        uiOrigin: "https://a.example.com,https://b.example.com",
      })
    ).toThrow("UI_ORIGIN must be a single absolute URL when credentials are enabled");
  });

  it("throws when UI_ORIGIN is empty", () => {
    expect(() =>
      validateProductionConfig({ ...validSecrets, uiOrigin: "" })
    ).toThrow("UI_ORIGIN is not set");
  });

  it("throws when UI_ORIGIN is not an absolute URL", () => {
    expect(() =>
      validateProductionConfig({ ...validSecrets, uiOrigin: "not-a-url" })
    ).toThrow("UI_ORIGIN must be an absolute URL");
  });

  it("does not throw when UI_ORIGIN is a valid absolute URL", () => {
    expect(() =>
      validateProductionConfig({ ...validSecrets, uiOrigin: "https://app.gatewerk.com" })
    ).not.toThrow();
  });

  // TOTP_ENCRYPTION_KEY cloud-mode gate
  it("throws when GATEWERK_MODE=cloud and TOTP_ENCRYPTION_KEY is unset", () => {
    expect(() =>
      validateProductionConfig({
        ...validSecrets,
        uiOrigin: "https://app.gatewerk.com",
        mode: "cloud",
        totpEncryptionKey: undefined,
      })
    ).toThrow("TOTP_ENCRYPTION_KEY is not set");
  });

  it("does not throw when GATEWERK_MODE=standalone and TOTP_ENCRYPTION_KEY is unset", () => {
    expect(() =>
      validateProductionConfig({
        ...validSecrets,
        uiOrigin: "https://app.gatewerk.com",
        mode: "standalone",
        totpEncryptionKey: undefined,
      })
    ).not.toThrow();
  });

  it("does not throw when GATEWERK_MODE=cloud and TOTP_ENCRYPTION_KEY is set", () => {
    expect(() =>
      validateProductionConfig({
        ...validSecrets,
        uiOrigin: "https://app.gatewerk.com",
        mode: "cloud",
        totpEncryptionKey: "a-real-32-byte-totp-encryption-key",
      })
    ).not.toThrow();
  });
});

// Regression for the fail-open config fallbacks. Pre-fix, `config.ts` fell back to
// "dev-secret"/"dev-jwt-secret"/localhost URLs whenever the real envs were
// unset AND NODE_ENV != "production". That booted the server with a public
// dev HMAC under unset NODE_ENV. These tests pin the fail-closed contract.
describe("requireEnv", () => {
  const VAR = "GATEWERK_CONFIG_TEST_VAR";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the env value when set to a non-empty string", () => {
    vi.stubEnv(VAR, "real-value");
    expect(requireEnv(VAR, "fallback")).toBe("real-value");
  });

  it("returns the test fallback when env is unset under VITEST=true", () => {
    vi.stubEnv(VAR, "");
    expect(requireEnv(VAR, "test-fallback")).toBe("test-fallback");
  });

  it("returns the test fallback when env is unset under NODE_ENV=test", () => {
    vi.stubEnv(VAR, "");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "test");
    expect(requireEnv(VAR, "test-fallback")).toBe("test-fallback");
  });

  it("throws BootError when env is unset outside the test path", () => {
    vi.stubEnv(VAR, "");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => requireEnv(VAR, "fallback")).toThrow(BootError);
    expect(() => requireEnv(VAR, "fallback")).toThrow(
      `FATAL: ${VAR} is not set`,
    );
  });

  it("treats an empty-string env value as unset (fails closed in prod)", () => {
    vi.stubEnv(VAR, "");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(() => requireEnv(VAR, "fallback")).toThrow(/is not set/);
  });

  it("emits a stable error code for ops tooling", () => {
    vi.stubEnv(VAR, "");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    try {
      requireEnv(VAR, "fallback");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BootError);
      expect((err as BootError).code).toBe(`missing_env_${VAR.toLowerCase()}`);
    }
  });
});

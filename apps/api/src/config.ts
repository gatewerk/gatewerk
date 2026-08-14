import { BootError, GATEWERK_MODES, type GatewerkMode } from "@gatewerk/shared";
import { serverEnv } from "./env";

/**
 * Fail-closed env reader. Returns the env value when set to a non-empty
 * string. In the test environment (NODE_ENV=test or VITEST=true) returns
 * the provided `testFallback` so the suite can boot without setting envs.
 * Anywhere else — dev, staging, prod, unset NODE_ENV — a missing value
 * throws at module-init time and the server never binds.
 *
 * The prior `||` fallback pattern booted the
 * server with `dev-secret`/`dev-jwt-secret` whenever the secret envs were
 * unset AND NODE_ENV was anything other than "production". Under unset
 * NODE_ENV on a misconfigured prod host, that meant forgeable JWTs and
 * HMAC signing with a public dev value. Fail-closed at init eliminates
 * the fail-open fallback chain entirely.
 *
 * Exported for unit testing — the module-level call sites are evaluated
 * once at import, so we need the pure function to exercise edge cases.
 */
export function requireEnv(name: string, testFallback: string): string {
  const raw = process.env[name];
  if (raw && raw.length > 0) return raw;
  if (isTestEnv()) return testFallback;
  throw new BootError(
    `FATAL: ${name} is not set. Define it before starting the server.`,
    `missing_env_${name.toLowerCase()}`,
  );
}

function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

/**
 * Optional env reader. Returns the env value when set to a non-empty string;
 * returns `undefined` when missing or empty. Distinct from `requireEnv`
 * which fails closed.
 *
 * SMTP_* envs follow graceful-degrade semantics — when unset, the email
 * service short-circuits with `{ status: "skipped_no_config" }` rather
 * than refusing to boot. OSS operators who never configure SMTP still
 * get a healthy server; consumer routes that need email coverage decide
 * their own fallback.
 *
 * Test-aware: returns `undefined` unconditionally under NODE_ENV=test or
 * VITEST=true, regardless of whether the underlying env is set in the
 * parent shell. This protects every test from inherited SMTP_* exports
 * silently flipping the configured-vs-skipped branch — tests that need
 * to simulate "SMTP configured" must do so via injected transport (or
 * vi.stubEnv inside the test body), not env leak.
 *
 * @internal — no external consumers; kept alongside requireEnv so the
 * test-aware posture for SMTP_* is preserved without depending on t3-env
 * skipValidation behaviour.
 */
function optionalEnv(name: string): string | undefined {
  if (isTestEnv()) return undefined;
  const raw = process.env[name];
  if (raw && raw.length > 0) return raw;
  return undefined;
}

/**
 * Optional integer env reader. Returns the parsed value when env is set to
 * a parseable integer; returns `undefined` when missing or empty. Throws
 * `BootError` when set but unparseable (fail-closed on typo) so a
 * misconfigured `SMTP_PORT="abc"` never silently falls back to undefined.
 *
 * Test-aware: same posture as `optionalEnv` — returns `undefined` in test
 * env regardless of the underlying value, including when the value is
 * unparseable. Tests construct numeric config explicitly, not via env.
 *
 * @internal — no external consumers; kept to preserve SMTP_PORT parse
 * semantics without coupling to t3-env's z.coerce.number() behaviour.
 */
function optionalIntEnv(name: string): number | undefined {
  if (isTestEnv()) return undefined;
  const raw = process.env[name];
  if (!raw || raw.length === 0) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new BootError(
      `FATAL: ${name}="${raw}" is not a valid integer.`,
      `invalid_env_${name.toLowerCase()}`,
    );
  }
  return n;
}

/**
 * Resolve the Gatewerk runtime mode from env.
 *
 * Defaults to "standalone" (OSS) when GATEWERK_MODE is unset or empty.
 * Accepts only the literal values in `GATEWERK_MODES` — any other value
 * throws `BootError` at module init so the server never binds. Fail-closed
 * on typos, uppercase variants, legacy values, etc.
 *
 * M21: this is the single gate that decides whether `ee/bootstrap.ts`
 * gets dynamically imported. The `ee/` directory is absent from OSS
 * builds; attempting the import in standalone mode would not even reach
 * Node's module resolver because `mountEeIfCloud` short-circuits first.
 *
 * Exported for unit testing (gatewerk-mode.test.ts). Production code
 * should prefer config.mode which is derived from this at module init.
 */
export function readMode(): GatewerkMode {
  const raw = process.env.GATEWERK_MODE;
  if (!raw || raw.length === 0) return "standalone";
  if ((GATEWERK_MODES as readonly string[]).includes(raw)) {
    return raw as GatewerkMode;
  }
  throw new BootError(
    `FATAL: GATEWERK_MODE="${raw}" is not a valid mode. Expected one of: ${GATEWERK_MODES.join(", ")}.`,
    "invalid_env_gatewerk_mode",
  );
}

// config owns derived / computed values (composed URLs, rate-limit math,
// timeouts). Raw env reads now route through serverEnv (the t3-env registry
// in ./env.ts). The exported key names (databaseUrl, jwtSecret, …) are
// preserved unchanged so all consumer code (routes/, middleware/, services/,
// lib/) typechecks without modifications in this commit. Subsequent Group
// A–D migration commits replace call-site direct process.env reads.
//
// Test fallbacks for the five required vars are preserved via requireEnv
// because serverEnv skips validation in test mode and those callers need
// a concrete non-undefined value — keepingrequireEnv for the test path
// avoids silently changing the "what value does config.databaseUrl return
// in test?" contract.
export const config = {
  port: serverEnv.PORT,
  mode: serverEnv.GATEWERK_MODE as GatewerkMode,
  totpEncryptionKey: serverEnv.TOTP_ENCRYPTION_KEY,
  databaseUrl: requireEnv(
    "DATABASE_URL",
    "postgresql://gatewerk:gatewerk@localhost:5432/gatewerk",
  ),
  hmacSecret: requireEnv("HMAC_SECRET", "test-hmac-secret-do-not-use-in-prod"),
  jwtSecret: requireEnv("JWT_SECRET", "test-jwt-secret-do-not-use-in-prod"),
  // OTP_HMAC_SECRET is the signing key for short-TTL email-OTP code hashes
  // (HMAC-SHA256). Held separately from JWT_SECRET so each can rotate on
  // its own cadence — recipient OTP hashes vs reviewer session signing
  // have different blast radii on key compromise.
  otpHmacSecret: requireEnv("OTP_HMAC_SECRET", "test-otp-hmac-secret-do-not-use-in-prod"),
  uiOrigin: requireEnv("UI_ORIGIN", "http://localhost:5173"),
  // Public API base URL for building absolute API links (e.g. List-Unsubscribe
  // headers in digest emails). Falls back to uiOrigin for OSS single-origin
  // deployments. Set API_ORIGIN explicitly when API and UI are on separate origins.
  get apiOrigin(): string {
    return serverEnv.API_ORIGIN ?? this.uiOrigin;
  },
  // Absolute URL of the mark shown in email, served by THIS deployment's own
  // web origin. Never a gatewerk.com URL: a self-hoster's recipients would
  // then report their IP and open time to a CDN we run, from a deployment we
  // do not run, and they are not our users. The asset ships in
  // apps/web/public/brand/ (what every compose file builds today) and in
  // apps/web-next/public/brand/ so it survives the cutover.
  // Spec: EMAIL_BUILD_SPEC.md §4.
  get emailLogoUrl(): string {
    // UI_ORIGIN is operator-supplied and may carry a trailing slash.
    return `${this.uiOrigin.replace(/\/+$/, "")}/brand/gatewerk-logo-256.png`;
  },
  // SMTP_* envs are OPTIONAL. When unset, the email service returns
  // `{ status: "skipped_no_config" }` rather than throwing — graceful-degrade
  // is the OSS posture so operators who never configure SMTP still get a
  // healthy server.
  // optionalEnv/optionalIntEnv are used here (not serverEnv) to preserve the
  // test-aware posture: they return undefined in test mode regardless of env,
  // protecting tests from inherited SMTP_* shell exports.
  smtp: {
    host: optionalEnv("SMTP_HOST"),
    port: optionalIntEnv("SMTP_PORT"),
    secure: optionalEnv("SMTP_SECURE") === "true",
    user: optionalEnv("SMTP_USER"),
    pass: optionalEnv("SMTP_PASS"),
    from: optionalEnv("SMTP_FROM"),
    // Per-stream sender addresses. Transactional (OTP, reset, verify) prefer
    // txFrom; notification/batch (digest, dunning) prefer notifyFrom. Both
    // fall back to `from` so operators with a single address still work.
    txFrom: optionalEnv("SMTP_FROM_TX"),
    notifyFrom: optionalEnv("SMTP_FROM_NOTIFY"),
    // Reply-To / List-Unsubscribe target; see env.ts for why it has no default.
    contact: optionalEnv("EMAIL_CONTACT_ADDRESS"),
  },
  resendApiKey: optionalEnv("RESEND_API_KEY"),
  resendWebhookSecret: optionalEnv("RESEND_WEBHOOK_SECRET"),
  hookdeckApiKey: optionalEnv("HOOKDECK_API_KEY"),
  cloud: {
    supabaseUrl: optionalEnv("SUPABASE_URL"),
    supabaseAnonKey: optionalEnv("SUPABASE_ANON_KEY"),
    supabaseServiceKey: optionalEnv("SUPABASE_SERVICE_KEY"),
    stripeSecretKey: optionalEnv("STRIPE_SECRET_KEY"),
    stripeWebhookSecret: optionalEnv("STRIPE_WEBHOOK_SECRET"),
    sentryDsn: optionalEnv("SENTRY_DSN"),
    posthogKey: optionalEnv("POSTHOG_KEY"),
    turnstileSecretKey: optionalEnv("TURNSTILE_SECRET_KEY"),
    r2AccessKey: optionalEnv("CLOUDFLARE_R2_ACCESS_KEY"),
    r2SecretKey: optionalEnv("CLOUDFLARE_R2_SECRET_KEY"),
    r2Bucket: optionalEnv("CLOUDFLARE_R2_BUCKET"),
    r2Endpoint: optionalEnv("CLOUDFLARE_R2_ENDPOINT"),
  },
};

const INSECURE_DEFAULTS = ["dev-secret", "dev-jwt-secret"];

// Test fallback for OTP_HMAC_SECRET. Validated separately because the
// historical INSECURE_DEFAULTS list pre-existed the OTP secret and a
// production host that defaults the OTP secret to the public test value
// must fail closed. Mirrors the JWT_SECRET / HMAC_SECRET pattern but
// kept in a distinct list so the legacy two-secret check semantics are
// preserved verbatim for the existing config-validation test suite.
const INSECURE_OTP_DEFAULTS = ["test-otp-hmac-secret-do-not-use-in-prod"];

/**
 * Defense-in-depth companion to the module-init throw. Catches the case
 * where an operator explicitly sets HMAC_SECRET or JWT_SECRET to one of
 * the historical dev sentinels — `requireEnv` accepts any non-empty
 * string, so the sentinel would otherwise slip through.
 *
 * Always invoked at boot outside the test path; kept exported for the
 * unit suite that exercises the override form.
 */
export function validateProductionConfig(overrides?: {
  jwtSecret?: string;
  hmacSecret?: string;
  otpHmacSecret?: string;
  uiOrigin?: string;
  mode?: GatewerkMode;
  totpEncryptionKey?: string;
}) {
  const jwt = overrides?.jwtSecret ?? config.jwtSecret;
  const hmac = overrides?.hmacSecret ?? config.hmacSecret;
  const otp = overrides?.otpHmacSecret ?? config.otpHmacSecret;

  if (INSECURE_DEFAULTS.includes(jwt)) {
    throw new BootError(
      "FATAL: JWT_SECRET uses insecure default. Set JWT_SECRET environment variable.",
      "insecure_jwt_secret",
    );
  }
  if (INSECURE_DEFAULTS.includes(hmac)) {
    throw new BootError(
      "FATAL: HMAC_SECRET uses insecure default. Set HMAC_SECRET environment variable.",
      "insecure_hmac_secret",
    );
  }
  if (INSECURE_OTP_DEFAULTS.includes(otp)) {
    throw new BootError(
      "FATAL: OTP_HMAC_SECRET uses insecure default. Set OTP_HMAC_SECRET environment variable.",
      "insecure_otp_hmac_secret",
    );
  }

  const ui = overrides?.uiOrigin ?? serverEnv.UI_ORIGIN ?? "";
  if (ui === "") {
    throw new BootError(
      "FATAL: UI_ORIGIN is not set. Set UI_ORIGIN to the absolute URL of the dashboard.",
      "missing_ui_origin",
    );
  }
  if (ui === "*" || ui.includes(",")) {
    throw new Error("UI_ORIGIN must be a single absolute URL when credentials are enabled (cors)");
  }
  try { new URL(ui); } catch {
    throw new Error(`UI_ORIGIN must be an absolute URL; got: ${ui}`);
  }

  const mode = overrides?.mode ?? config.mode;
  const totp = overrides?.totpEncryptionKey ?? config.totpEncryptionKey;
  // TOTP_ENCRYPTION_KEY: required when GATEWERK_MODE=cloud regardless of any user
  // having 2FA enabled — fail-loudly at boot is safer than crashing on first TOTP use.
  // Lane E (entitlements) may later replace this with a discriminated-when-entitlement-on
  // schema if the env-validation layer learns to query entitlements at boot.
  if (mode === "cloud" && (!totp || totp.length === 0)) {
    throw new BootError(
      "FATAL: TOTP_ENCRYPTION_KEY is not set. Required when GATEWERK_MODE=cloud.",
      "missing_totp_encryption_key",
    );
  }
}

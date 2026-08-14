// Typed env contract for the API server.
//
// This module is the SINGLE SOURCE OF TRUTH for "what raw env vars exist
// + their types + their required-vs-optional shape". `config.ts` derives
// computed values (rate-limit math, URL composition, timeouts) FROM env.X
// reads. The two MUST agree on required-vs-optional; divergence is a bug.
//
// In production, missing required vars throw at boot (via the t3-env
// schema validation that runs when `serverEnv` is first dereferenced).
// In test (NODE_ENV=test or VITEST=true), validation is skipped — the
// existing config.ts requireEnv/optionalEnv test-fallback semantics cover
// the test-mode-divergence case. Tests that set process.env.X directly
// (e.g. two-factor.test.ts setting TOTP_ENCRYPTION_KEY) continue to work
// because skipValidation lets module-level reads return whatever
// process.env holds at test time.

import { BootError } from "@gatewerk/shared";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// Regex to detect var names that hold secrets. Matched names have their value
// replaced with "[redacted]" in boot-error messages so secrets never appear in
// logs.
const SECRET_VAR_RE = /SECRET|TOKEN|KEY|PASSWORD|HMAC|DSN|PASS/i;

/**
 * Build a human-readable FATAL message from the StandardSchema issues that
 * t3-env surfaces on validation failure. Each issue names the failing var and
 * echoes its raw value — with secret vars redacted — so operators can fix
 * misconfigured environments without reading source code.
 *
 * Signature matches the t3-env `onValidationError` option:
 *   (issues: readonly StandardSchemaV1.Issue[]) => never
 */
function buildEnvBootError(issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }>): never {
  const lines = issues.map((issue) => {
    const pathSegment = issue.path?.[0];
    const varName =
      pathSegment !== undefined
        ? typeof pathSegment === "object" && "key" in pathSegment
          ? String(pathSegment.key)
          : String(pathSegment)
        : "(unknown)";
    const rawValue = process.env[varName];
    const displayValue = SECRET_VAR_RE.test(varName)
      ? "[redacted]"
      : rawValue !== undefined
        ? `"${rawValue}"`
        : '""';
    return `  ${varName}: ${displayValue} — ${issue.message}`;
  });
  throw new BootError(
    `FATAL: invalid environment variable(s):\n${lines.join("\n")}`,
    "invalid_env",
  );
}

export const serverEnv = createEnv({
  server: {
    // Group A — Required at boot (prod). Test-fallback strings preserve
    // the existing config.ts requireEnv semantics for test runs.
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(1),
    HMAC_SECRET: z.string().min(1),
    OTP_HMAC_SECRET: z.string().min(1),
    UI_ORIGIN: z.string().min(1),

    // Group B — Optional with safe default.
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    GATEWERK_MODE: z.enum(["standalone", "cloud"]).default("standalone"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    UPLOADS_DIR: z.string().default("/data/uploads"),
    SESSION_INACTIVITY_TIMEOUT_HOURS: z.coerce
      .number()
      .int()
      .positive()
      .default(24),

    // Group C — Cloud-only optional. Present when GATEWERK_MODE=cloud.
    // The ee/ runtime enforces presence at startup, not env.ts.
    STRIPE_PRICE_ID_SOLO: z.string().optional(),
    STRIPE_PRICE_ID_TEAM: z.string().optional(),
    STRIPE_PRICE_ID_BUSINESS: z.string().optional(),
    STRIPE_METER_ID_REVIEWS: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_ANON_KEY: z.string().optional(),
    SUPABASE_SERVICE_KEY: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),
    RESEND_WEBHOOK_SECRET: z.string().optional(),
    HOOKDECK_API_KEY: z.string().optional(),
    SENTRY_DSN: z.string().url().optional(),
    POSTHOG_KEY: z.string().optional(),
    TURNSTILE_SECRET_KEY: z.string().optional(),
    CLOUDFLARE_R2_ACCESS_KEY: z.string().optional(),
    CLOUDFLARE_R2_SECRET_KEY: z.string().optional(),
    CLOUDFLARE_R2_BUCKET: z.string().optional(),
    CLOUDFLARE_R2_ENDPOINT: z.string().url().optional(),

    // Group C-aux — SMTP transport (optional in both OSS + Cloud;
    // absence triggers graceful no-email mode).
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().optional(),
    SMTP_SECURE: z.enum(["true", "false"]).optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),
    // Per-stream sender addresses. When set, transactional emails (OTP, reset,
    // verify) use SMTP_FROM_TX and notification/batch emails (digest, dunning)
    // use SMTP_FROM_NOTIFY. Both fall back to SMTP_FROM when unset so OSS
    // operators can boot with a single address.
    SMTP_FROM_TX: z.string().optional(),
    SMTP_FROM_NOTIFY: z.string().optional(),
    // Address a human actually reads. Used for Reply-To and as the
    // List-Unsubscribe mailto target. Deliberately unset by default: the
    // send-from address is usually a no-reply mailbox, and defaulting this
    // to any Gatewerk-operated address would point self-hosters' recipients
    // at us instead of at them.
    EMAIL_CONTACT_ADDRESS: z.string().optional(),

    // Public API base URL. Used to build List-Unsubscribe headers in outbound
    // digest emails (Task 6). Optional — falls back to UI_ORIGIN at runtime so
    // OSS operators who serve API + UI from the same origin need not set this.
    API_ORIGIN: z.string().url().optional(),

    // Group D — Feature flags / dev / test hatches.
    VITEST: z.string().optional(),
    SKIP_HIBP: z.enum(["true", "false"]).optional(),
    SKIP_DNS_SSRF: z.enum(["true", "false"]).optional(),
    TEST_DATABASE_URL: z.string().optional(),
    // TOTP_ENCRYPTION_KEY stays optional — it fails at use site in
    // services/totp.ts when missing, preserving the existing behavior
    // of returning undefined and letting the caller throw contextually.
    TOTP_ENCRYPTION_KEY: z.string().optional(),
    // SLACK_TOKEN_ENCRYPTION_KEY stays optional — consumed at Slack-install
    // time only; Slack integration is opt-in and not required at boot.
    SLACK_TOKEN_ENCRYPTION_KEY: z.string().optional(),
    // Slack OAuth app credentials — optional; Slack integration is BYO-app.
    SLACK_CLIENT_ID: z.string().optional(),
    SLACK_CLIENT_SECRET: z.string().optional(),
  },
  runtimeEnv: process.env,
  onValidationError: buildEnvBootError,
  // Skip validation in test runs — config.ts test-fallbacks (the second
  // argument to requireEnv) cover the test-mode-divergence case. Tests
  // also seed fixture env vars directly via vi.stubEnv / process.env
  // mutation; skipValidation ensures those take effect without the
  // schema throwing on missing required vars.
  //
  // IMPORTANT: this predicate uses direct process.env reads — NOT
  // serverEnv — because it runs during the createEnv bootstrap call
  // BEFORE serverEnv is available. Using serverEnv here would be
  // circular.
  //
  // Production validation still fires at boot via the side-effect import
  // in apps/api/src/index.ts. Lane E (entitlements) is the natural home
  // for the future discriminated-validation pass that requires cloud-only
  // vars when GATEWERK_MODE=cloud.
  skipValidation:
    process.env.NODE_ENV === "test" || process.env.VITEST === "true",
  emptyStringAsUndefined: true,
});

// Cloud-mode boot-time validator: forbid placeholder Stripe IDs in production.
// Lane E ships with defensive fallbacks (e.g., "price_test_team_placeholder")
// to keep dev/test green even without real Stripe IDs. In Cloud mode those
// placeholders would silently route checkouts to non-existent prices; fail
// loud here so deployments catch the misconfiguration at boot rather than at
// the first user checkout attempt.
const isTestEnv =
  process.env.NODE_ENV === "test" || process.env.VITEST === "true";

if (serverEnv.GATEWERK_MODE === "cloud" && !isTestEnv) {
  const stripeRequired: Record<string, string | undefined> = {
    // Solo is the only purchasable plan at launch, so it is the one price that
    // absolutely must be real — yet it was the only one with no boot check.
    // Combined with the `?? "price_solo_monthly"` fallback in plans.ts, an
    // unset SOLO price would have surfaced as a failed Stripe checkout for a
    // paying customer instead of a refused boot.
    STRIPE_PRICE_ID_SOLO: serverEnv.STRIPE_PRICE_ID_SOLO,
    STRIPE_PRICE_ID_TEAM: serverEnv.STRIPE_PRICE_ID_TEAM,
    STRIPE_PRICE_ID_BUSINESS: serverEnv.STRIPE_PRICE_ID_BUSINESS,
    STRIPE_METER_ID_REVIEWS: serverEnv.STRIPE_METER_ID_REVIEWS,
  };
  const isPlaceholder = (name: string, value: string | undefined): boolean => {
    if (!value) return true;
    // Symmetric prefix check: meter IDs use mtr_test_ prefix; price IDs use
    // price_test_ prefix. Plans.ts emits both placeholder shapes; this
    // validator must reject both at boot in Cloud mode.
    const prefix = name.includes("METER") ? "mtr_test_" : "price_test_";
    return value.startsWith(prefix);
  };

  for (const [name, value] of Object.entries(stripeRequired)) {
    if (isPlaceholder(name, value)) {
      throw new BootError(
        `Cloud mode requires real ${name}; got ${value ?? "<undefined>"} — ` +
          `placeholder values are forbidden in production`,
        "invalid_env",
      );
    }
  }
  if (serverEnv.STRIPE_PRICE_ID_TEAM === serverEnv.STRIPE_PRICE_ID_BUSINESS) {
    throw new BootError(
      `STRIPE_PRICE_ID_TEAM and STRIPE_PRICE_ID_BUSINESS must differ; ` +
        `both set to ${serverEnv.STRIPE_PRICE_ID_TEAM}`,
      "invalid_env",
    );
  }
}

export type ServerEnv = typeof serverEnv;

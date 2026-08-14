# Auth Service — Architecture Note

This service owns the password / session / 2FA / external-token surface for Gatewerk.
We deliberately keep the auth layer in-house rather than extracting to Better Auth
(https://www.better-auth.com); rationale + targeted upgrades documented below.

## Why custom auth (not Better Auth)

Our three-tier auth system has load-bearing customizations:
- JWT audience/issuer pinning (`gatewerk-dashboard` / `gatewerk-api`)
- Hybrid JWT + DB sessions with per-session server-side revocation
- `token_version` bump on password change (legacy-token invalidation)
- 2FA TOTP + bcrypt-hashed backup codes
- Email-OTP for external reviewers (Phase 3 of Token Redesign)
- Rate-limit + lockout state machine per reviewer

Extracting to Better Auth would be a high-risk regression across all of these.
Instead, we adopt targeted upgrades within the existing layer.

## Targeted upgrades

### 1. argon2id password hashing (OWASP 2025)

- `services/auth/password.ts` exports `hashPassword()` / `verifyPassword()`.
- argon2id params: m=19456 KiB, t=2, p=1 per OWASP Password Storage Cheat Sheet 2025.
- Native `argon2` npm package (node-gyp prebuilds for darwin-arm64 + linux-x64; Alpine
  Docker requires `apk add python3 make g++` in the deps stage). If a deployment target
  ever fails the native build, fall back to `@node-rs/argon2` (pure-Rust WASM, identical
  API). Document the swap in the commit message.
- **Bcrypt-fallback verifier:** `verifyPassword` dispatches on hash prefix. Legacy
  bcrypt hashes ($2a$ / $2b$) verify via bcryptjs and signal `needsRehash: true` so
  callers can transparently upgrade on next login (see `routes/auth.ts` login handler).
- **Backup codes intentionally stay on bcryptjs** in `services/totp.ts`. They are
  high-entropy random 8-char strings with short TTL — argon2's cost has no security
  benefit there and adds login latency.
- Admin migration progress: `GET /api/v1/admin/password-hash-stats` returns aggregate
  format counts (argon2id vs bcrypt vs unknown).

### 2. @noble/hashes for HMAC paths

- `lib/crypto.ts` exports `hmacSha256()`, `hmacSha256Base64url()`, and `constantTimeEqual()`
  backed by `@noble/hashes` 2.x (audited TypeScript, zero deps, ESM-native).
- Byte-parity vs Node `crypto.createHmac` proven on 9 inputs spanning boundary
  conditions; RFC 4231 Test Case 1 known-answer test validates correctness vs spec.
- Wired into: `services/audit.ts` (chain), `services/webhooks.ts` (V1+V2),
  `lib/email-tokens.ts` (password-reset), `services/email-otp/codes.ts`.
- `node:crypto.createHash` (non-HMAC SHA-256) for API-key hashing, token hashing,
  and ETag generation stays as-is — not security-sensitive in the HMAC sense.
- `node:crypto.randomInt` retained (not provided by @noble/hashes).
- `constantTimeEqual` returns false on length mismatch instead of throwing (deliberate
  improvement over `crypto.timingSafeEqual`). All callers pass equal-length fixed-format
  hex/base64url outputs, so the divergence is non-load-bearing.

### 3. Passkeys (SimpleWebAuthn)

- Opt-in WebAuthn for phishing-resistant login. Implemented at `routes/passkeys.ts`.
  Additive — does not replace the existing TOTP 2FA path.
- A passkey login skips the TOTP gate; the bypass is recorded via
  `passkey.login_skipped_2fa` audit, awaited before JWT issuance rather than
  fire-and-forget so a session can never exist without its bypass record.

## Env contract surface

The auth layer's required + optional env vars live in `apps/api/src/env.ts`:
- Required: `JWT_SECRET`, `HMAC_SECRET`, `OTP_HMAC_SECRET`, `DATABASE_URL`, `UI_ORIGIN`.
- Cloud-required: `TOTP_ENCRYPTION_KEY` (Cloud-mode boot gate enforced at
  `validateProductionConfig()` in `config.ts`).
- Optional: `SMTP_*` (graceful-degrade no-email mode), Resend/Sentry/PostHog/Supabase
  (Cloud-only optional).

`env.ts`'s `onValidationError` hook in `env.ts:buildEnvBootError()` surfaces the specific
failing var name + value (with secrets redacted via `/SECRET|TOKEN|KEY|PASSWORD|HMAC|DSN|PASS/i`
regex) in boot errors. Restores the per-var actionability lost when the t3-env migration
replaced the original `BootError` echo path.

## External token model (overview)

The token redesign layered three auth tiers on top of the core
reviewer-session model.

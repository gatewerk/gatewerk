/**
 * Passkey (WebAuthn) routes — phishing-resistant second-factor login.
 *
 * Endpoints:
 *   POST /api/v1/auth/passkey/register/options  (sessionAuth)
 *   POST /api/v1/auth/passkey/register/verify   (sessionAuth)
 *   POST /api/v1/auth/passkey/login/options     (public — no auth)
 *   POST /api/v1/auth/passkey/login/verify      (public — no auth)
 *   GET  /api/v1/account/passkeys               (sessionAuth)
 *   DELETE /api/v1/account/passkeys/:id         (sessionAuth)
 *
 * Design decisions (adjudicated pre-implementation):
 *   D1 — userVerification=preferred, residentKey=preferred, attestation=none
 *   D2 — Counter: reject if newCounter <= stored UNLESS both are 0 (Apple quirk)
 *   D3 — Passkey login SKIPS 2FA gate (passkey is itself phishing-resistant)
 *   D4 — RP ID / origin derived from config.uiOrigin
 *
 * Challenge store: in-process Map with 5-min TTL. Acceptable for OSS
 * single-process deployments. Cloud multi-replica deployments should move
 * this to Redis so challenges are visible across instances.
 */

import { Router } from "express";
import jwt from "jsonwebtoken";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import { webauthn_credentials } from "@gatewerk/db/src/schema/webauthn-credentials";
import { reviewers } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import { AuthenticationError, ConflictError, NotFoundError, generateId } from "@gatewerk/shared";
import type { AuditAction } from "@gatewerk/shared";
import { sessionAuth } from "../middleware/session-auth";
import { createSessionService } from "../services/sessions";
import { config } from "../config";
import type { EmailService } from "../services/email";
import { notifyNewIpLogin } from "../lib/login-notifications";
import { isUniqueViolation } from "../lib/pg-error";

// ─── RP config ───────────────────────────────────────────────────────────────

function getRpConfig(): { rpID: string; rpName: string; expectedOrigin: string } {
  const uiUrl = new URL(config.uiOrigin);
  return {
    rpID: uiUrl.hostname,
    rpName: "Gatewerk",
    expectedOrigin: config.uiOrigin,
  };
}

// ─── Challenge store ─────────────────────────────────────────────────────────

interface ChallengeEntry {
  challenge: string;
  reviewerId: string;
  createdAt: number;
}

const challengeStore = new Map<string, ChallengeEntry>();
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Janitor: purge expired challenges every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of challengeStore) {
    if (now - entry.createdAt > CHALLENGE_TTL_MS) {
      challengeStore.delete(key);
    }
  }
}, 2 * 60 * 1000).unref();

function storeChallenge(challengeKey: string, challenge: string, reviewerId: string): void {
  challengeStore.set(challengeKey, { challenge, reviewerId, createdAt: Date.now() });
}

function consumeChallenge(challengeKey: string): ChallengeEntry | undefined {
  const entry = challengeStore.get(challengeKey);
  if (!entry) return undefined;
  // Consume immediately — single use
  challengeStore.delete(challengeKey);
  if (Date.now() - entry.createdAt > CHALLENGE_TTL_MS) return undefined;
  return entry;
}

// ─── Audit service interface ──────────────────────────────────────────────────

interface AuditService {
  log(data: {
    action: AuditAction;
    actor: string;
    resource_type: string;
    resource_id?: string;
    details?: Record<string, unknown>;
  }): Promise<any>;
}

// ─── Route factory ───────────────────────────────────────────────────────────

export function createPasskeyRoutes(db: AppDb, auditService: AuditService, emailService: EmailService): Router {
  const router = Router();
  const sessionService = createSessionService(db);

  // ── /login/verify helper — all 401s emit passkey.login_failed + return same code ──
  // Collapsing distinct error codes (credential_not_found vs verification_failed vs
  // counter_replay) prevents an attacker from probing which credential_ids exist via
  // response-code enumeration. The specific reason is recorded server-side only in the
  // audit log.
  function recordAndReturnPasskeyLoginFailure(
    reason: string,
    reviewerId: string | null,
    extra?: Record<string, unknown>,
  ) {
    auditService.log({
      action: "passkey.login_failed",
      actor: reviewerId ?? "__unknown__",
      resource_type: "reviewer",
      resource_id: reviewerId ?? "__unknown__",
      details: { reason, ...extra },
    }).catch((err) =>
      console.error("passkey_audit_emission_failed", { action: "passkey.login_failed", err }),
    );
    return new AuthenticationError("Passkey authentication failed", "passkey_login_failed");
  }

  // friendly_name is client-supplied display text persisted to the DB. Anything
  // non-string collapses to ""; strings are capped at 100 chars.
  function coerceFriendlyName(value: unknown): string {
    return typeof value === "string" ? value.slice(0, 100) : "";
  }

  // _challenge_key must be a non-empty string (it is a Map key); response must
  // be an object (it goes into the WebAuthn library verbatim).
  function hasValidCeremonyParams(challengeKey: unknown, response: unknown): boolean {
    return typeof challengeKey === "string" && challengeKey.length > 0
      && typeof response === "object" && response !== null;
  }

  // ── POST /auth/passkey/register/options (sessionAuth) ──────────────────────
  // Returns WebAuthn registration options and a challenge_key to correlate with verify.
  router.post("/auth/passkey/register/options", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const friendly_name: string = coerceFriendlyName(req.body?.friendly_name);

      // Collect existing credentials so we can exclude re-registration of same device
      const existing = await db
        .select({ credential_id: webauthn_credentials.credential_id })
        .from(webauthn_credentials)
        .where(eq(webauthn_credentials.user_id, reviewer.id));

      const { rpID, rpName } = getRpConfig();

      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userName: reviewer.email,
        userDisplayName: reviewer.name ?? reviewer.email,
        attestationType: "none",
        authenticatorSelection: {
          userVerification: "preferred",
          residentKey: "preferred",
        },
        excludeCredentials: existing.map(c => ({ id: c.credential_id })),
      });

      const challengeKey = generateId("passkey");
      storeChallenge(challengeKey, options.challenge, reviewer.id);

      res.json({ ...options, _challenge_key: challengeKey, _friendly_name: friendly_name });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /auth/passkey/register/verify (sessionAuth) ───────────────────────
  // Verifies the registration response and persists the new credential.
  router.post("/auth/passkey/register/verify", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const { _challenge_key, response, friendly_name } = req.body ?? {};

      if (!hasValidCeremonyParams(_challenge_key, response)) {
        return next(new AuthenticationError("Missing challenge_key or response", "missing_params"));
      }

      const entry = consumeChallenge(_challenge_key);
      if (!entry || entry.reviewerId !== reviewer.id) {
        return next(new AuthenticationError("Invalid or expired challenge", "invalid_challenge"));
      }

      const { rpID, expectedOrigin } = getRpConfig();

      const verification = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge: entry.challenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: false, // userVerification=preferred, not required
      });

      if (!verification.verified || !verification.registrationInfo) {
        return next(new AuthenticationError("Registration verification failed", "verification_failed"));
      }

      const { registrationInfo } = verification;
      const { credential, aaguid } = registrationInfo;

      const id = generateId("passkey");
      const name: string = coerceFriendlyName(friendly_name);

      try {
        await db.insert(webauthn_credentials).values({
          id,
          user_id: reviewer.id,
          credential_id: credential.id,
          public_key: credential.publicKey as unknown as Uint8Array,
          counter: credential.counter,
          transports: credential.transports ?? [],
          aaguid: aaguid ?? null,
          friendly_name: name,
        });
      } catch (err) {
        // WebAuthn credential_id is spec-guaranteed unique per authenticator;
        // this closes the race window on two concurrent registrations of the
        // same physical key. Read through drizzle's DrizzleQueryError wrapper
        // — see lib/pg-error.ts. Deliberately unnamed: this constraint has two
        // live names depending on how the DB was provisioned — Postgres
        // auto-generates `webauthn_credentials_credential_id_key` from the
        // unnamed inline UNIQUE in migrations/060_webauthn_credentials.sql on
        // an incrementally-migrated install, while a fresh install bootstrapped
        // from packages/db/scripts/baseline.sql gets the drizzle-declared
        // `webauthn_credentials_credential_id_unique`. webauthn_credentials has
        // no other unique column besides the PK, so an unnamed 23505 here is
        // unambiguous.
        if (isUniqueViolation(err)) {
          throw new ConflictError("This passkey is already registered", "passkey_already_registered");
        }
        throw err;
      }

      auditService.log({
        action: "passkey.registered",
        actor: reviewer.id,
        resource_type: "reviewer",
        resource_id: reviewer.id,
        details: { passkey_id: id, friendly_name: name, aaguid: aaguid ?? null },
      }).catch((err) =>
        console.error("passkey_audit_emission_failed", { action: "passkey.registered", reviewer_id: reviewer.id, err }),
      );

      res.json({ verified: true, id });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /auth/passkey/login/options (public — no auth) ───────────────────
  // Returns WebAuthn authentication options for a given email.
  // Email enumeration protection: unknown email returns options with empty allowCredentials.
  router.post("/auth/passkey/login/options", async (req, res, next) => {
    try {
      const { email } = req.body ?? {};

      if (!email || typeof email !== "string") {
        return next(new AuthenticationError("email is required", "missing_email"));
      }

      const { rpID } = getRpConfig();

      // Look up user — fall through gracefully if not found (enumeration protection)
      const [reviewer] = await db
        .select({ id: reviewers.id, email: reviewers.email })
        .from(reviewers)
        .where(eq(reviewers.email, email.toLowerCase().trim()))
        .limit(1);

      let allowCredentials: Array<{ id: string; transports?: string[] }> = [];
      // "__unknown__" sentinel so verify step can return a consistent 401
      const reviewerId = reviewer?.id ?? "__unknown__";

      if (reviewer) {
        const creds = await db
          .select({ credential_id: webauthn_credentials.credential_id, transports: webauthn_credentials.transports })
          .from(webauthn_credentials)
          .where(eq(webauthn_credentials.user_id, reviewer.id));

        allowCredentials = creds.map(c => ({
          id: c.credential_id,
          transports: c.transports ?? undefined,
        }));
      } else {
        // Timing-equivalent dummy lookup — match the real-user branch's query shape so
        // an enumeration probe measuring response latency cannot distinguish "user
        // exists" from "user does not exist". The result is discarded; allowCredentials
        // remains empty []. WHERE clause uses a sentinel that cannot match any real
        // user_id.
        await db.select({ credential_id: webauthn_credentials.credential_id, transports: webauthn_credentials.transports })
          .from(webauthn_credentials)
          .where(eq(webauthn_credentials.user_id, "__enumeration_dummy__"));
      }

      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: "preferred",
        allowCredentials: allowCredentials as any,
      });

      const challengeKey = generateId("passkey");
      storeChallenge(challengeKey, options.challenge, reviewerId);

      res.json({ ...options, _challenge_key: challengeKey });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /auth/passkey/login/verify (public — no auth) ────────────────────
  // Verifies the authentication assertion and issues a JWT (mirrors auth.ts login).
  // D3: passkey login SKIPS the 2FA gate — passkey is itself a strong factor.
  router.post("/auth/passkey/login/verify", async (req, res, next) => {
    try {
      const { _challenge_key, response } = req.body ?? {};

      if (!hasValidCeremonyParams(_challenge_key, response)) {
        return next(new AuthenticationError("Missing challenge_key or response", "missing_params"));
      }

      const entry = consumeChallenge(_challenge_key);
      if (!entry || entry.reviewerId === "__unknown__") {
        return next(recordAndReturnPasskeyLoginFailure("invalid_or_expired_challenge", null));
      }

      // Load the credential the client claims to use (by credential_id in response.id)
      const credentialId: string = (response as AuthenticationResponseJSON).id;

      const [cred] = await db
        .select()
        .from(webauthn_credentials)
        .where(
          and(
            eq(webauthn_credentials.credential_id, credentialId),
            eq(webauthn_credentials.user_id, entry.reviewerId),
          ),
        )
        .limit(1);

      if (!cred) {
        return next(recordAndReturnPasskeyLoginFailure("credential_not_found", entry.reviewerId));
      }

      const { rpID, expectedOrigin } = getRpConfig();

      const verification = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge: entry.challenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: false,
        credential: {
          id: cred.credential_id,
          publicKey: cred.public_key as any,
          counter: cred.counter,
          transports: (cred.transports ?? undefined) as any,
        },
      });

      if (!verification.verified) {
        return next(recordAndReturnPasskeyLoginFailure("verification_failed", entry.reviewerId));
      }

      const { newCounter } = verification.authenticationInfo;
      const storedCounter = cred.counter;

      // D2 — counter monotonicity: reject replay UNLESS both counters are 0
      // (Apple platform authenticators always return 0).
      if (storedCounter !== 0 || newCounter !== 0) {
        if (newCounter <= storedCounter) {
          return next(recordAndReturnPasskeyLoginFailure("counter_replay", entry.reviewerId, { stored: storedCounter, received: newCounter }));
        }
      }

      // Update counter + last_used_at
      await db
        .update(webauthn_credentials)
        .set({ counter: newCounter, last_used_at: new Date() })
        .where(eq(webauthn_credentials.id, cred.id));

      // Load full reviewer row for JWT issuance
      const [reviewer] = await db
        .select()
        .from(reviewers)
        .where(eq(reviewers.id, entry.reviewerId))
        .limit(1);

      if (!reviewer || !reviewer.is_active) {
        return next(recordAndReturnPasskeyLoginFailure("account_inactive", entry.reviewerId));
      }

      // D3 — if user has TOTP enabled, emit audit BEFORE issuing JWT (skip the gate).
      // Audit MUST commit before JWT issuance — a 2FA-bypass token issued without
      // forensic record is a security incident waiting to happen. We AWAIT (not
      // fire-and-forget) so a DB failure here aborts the login with 500. The user
      // can retry; the operator sees the failure in Sentry via the route-level
      // error handler.
      if (reviewer.totp_enabled_at) {
        await auditService.log({
          action: "passkey.login_skipped_2fa",
          actor: reviewer.id,
          resource_type: "reviewer",
          resource_id: reviewer.id,
          details: { passkey_id: cred.id },
        });
      }

      // Mirror auth.ts:251-265 JWT issuance
      const { jti, sessionId } = await sessionService.create({
        reviewerId: reviewer.id,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] as string | undefined,
      });

      const token = jwt.sign(
        {
          sub: reviewer.id,
          email: reviewer.email,
          role: reviewer.role,
          tokenVersion: reviewer.token_version ?? 0,
          jti,
        },
        config.jwtSecret,
        { expiresIn: "7d", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
      );

      auditService.log({
        action: "passkey.login_success",
        actor: reviewer.id,
        resource_type: "session",
        resource_id: sessionId,
        details: { ip: req.ip, passkey_id: cred.id },
      }).catch((err) =>
        console.error("passkey_audit_emission_failed", { action: "passkey.login_success", reviewer_id: reviewer.id, err }),
      );
      // Mirror auth.ts:294/710 — passkey sign-in previously never reached this,
      // so a passkey-only user got zero new-IP email regardless of their
      // Login notifications setting.
      notifyNewIpLogin(db, emailService, reviewer, req.ip, req.headers["user-agent"] as string | undefined).catch(() => {});

      res.json({
        token,
        reviewer: {
          id: reviewer.id,
          email: reviewer.email,
          name: reviewer.name,
          role: reviewer.role,
        },
        must_change_password: reviewer.must_change_password ?? false,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /account/passkeys (sessionAuth) ────────────────────────────────────
  // Lists the caller's registered passkeys (safe fields only — no public_key or credential_id).
  router.get("/account/passkeys", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;

      const items = await db
        .select({
          id: webauthn_credentials.id,
          friendly_name: webauthn_credentials.friendly_name,
          transports: webauthn_credentials.transports,
          created_at: webauthn_credentials.created_at,
          last_used_at: webauthn_credentials.last_used_at,
        })
        .from(webauthn_credentials)
        .where(eq(webauthn_credentials.user_id, reviewer.id));

      res.json({ items, total: items.length });
    } catch (err) {
      next(err);
    }
  });

  // ── DELETE /account/passkeys/:id (sessionAuth) ─────────────────────────────
  // Removes a passkey. Only succeeds if it belongs to the caller.
  router.delete("/account/passkeys/:id", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const { id } = req.params;

      const passkeyId = String(id);
      const deleted = await db
        .delete(webauthn_credentials)
        .where(
          and(
            eq(webauthn_credentials.id, passkeyId),
            eq(webauthn_credentials.user_id, String(reviewer.id)),
          ),
        )
        .returning({ id: webauthn_credentials.id });

      if (deleted.length === 0) {
        return next(new NotFoundError("Passkey not found", "passkey_not_found"));
      }

      auditService.log({
        action: "passkey.removed",
        actor: reviewer.id,
        resource_type: "reviewer",
        resource_id: reviewer.id,
        details: { passkey_id: id },
      }).catch((err) =>
        console.error("passkey_audit_emission_failed", { action: "passkey.removed", reviewer_id: reviewer.id, err }),
      );

      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

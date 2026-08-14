/**
 * Integration tests for WebAuthn passkey routes.
 *
 * @simplewebauthn/server's crypto functions are mocked — we trust the library
 * to verify its own cryptographic operations. Our tests verify that the routes
 * call the library correctly and handle all result shapes correctly.
 *
 * 6 scenarios:
 *  1. Happy path — register, list, login, counter advances
 *  2. Replay rejection — newCounter <= storedCounter (excluding both-zero)
 *  3. Wrong RP-ID / verification failure — verifyAuthenticationResponse returns verified=false
 *  4. Wrong-user — credential registered to user A, login attempted for user B
 *  5. Counter=0 edge case — Apple authenticator quirk: both counters 0, must accept
 *  6. Delete revokes — register → delete → login attempt returns 401
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { webauthn_credentials } from "@gatewerk/db/src/schema/webauthn-credentials";
import { generateId } from "@gatewerk/shared";

// ─── Mock @simplewebauthn/server ─────────────────────────────────────────────
// We trust the library's crypto; our tests verify route logic only.
vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

const mockGenReg = generateRegistrationOptions as ReturnType<typeof vi.fn>;
const mockVerReg = verifyRegistrationResponse as ReturnType<typeof vi.fn>;
const mockGenAuth = generateAuthenticationOptions as ReturnType<typeof vi.fn>;
const mockVerAuth = verifyAuthenticationResponse as ReturnType<typeof vi.fn>;

// ─── Shared fake data ─────────────────────────────────────────────────────────

const FAKE_CHALLENGE = "dGVzdGNoYWxsZW5nZWhlcmU";  // base64url "testchallengehere"
const FAKE_CRED_ID = "Y3JlZGVudGlhbElk";              // base64url "credentialId"
const FAKE_PUB_KEY = new Uint8Array([1, 2, 3, 4, 5]);

function fakeRegOptions(challenge = FAKE_CHALLENGE) {
  return {
    challenge,
    rp: { name: "Gatewerk", id: "localhost" },
    user: { id: "dXNlcklk", name: "test@test.com", displayName: "test@test.com" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    timeout: 60000,
    attestation: "none",
  };
}

function fakeAuthOptions(challenge = FAKE_CHALLENGE) {
  return {
    challenge,
    rpId: "localhost",
    timeout: 60000,
    userVerification: "preferred",
  };
}

function fakeVerRegSuccess(credId = FAKE_CRED_ID) {
  return {
    verified: true,
    registrationInfo: {
      credential: {
        id: credId,
        publicKey: FAKE_PUB_KEY,
        counter: 0,
        transports: ["internal"],
      },
      aaguid: "00000000-0000-0000-0000-000000000000",
      fmt: "none",
      credentialType: "public-key",
      attestationObject: new Uint8Array([]),
      userVerified: true,
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
      origin: "http://localhost:5173",
    },
  };
}

function fakeVerAuthSuccess(newCounter: number) {
  return {
    verified: true,
    authenticationInfo: {
      credentialID: FAKE_CRED_ID,
      newCounter,
      userVerified: true,
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
      origin: "http://localhost:5173",
      rpID: "localhost",
    },
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Passkey routes", () => {
  let db: any;
  let client: any;
  let app: Express;
  let userA: { reviewer: any; sessionToken: string };
  let userB: { reviewer: any; sessionToken: string };

  // Helper: register a passkey for a user and return the challenge key
  async function doRegisterOptions(token: string, challenge = FAKE_CHALLENGE): Promise<string> {
    mockGenReg.mockResolvedValueOnce(fakeRegOptions(challenge));
    const optRes = await request(app)
      .post("/api/v1/auth/passkey/register/options")
      .set("Authorization", `Bearer ${token}`)
      .send({ friendly_name: "My Key" });
    expect(optRes.status).toBe(200);
    return optRes.body._challenge_key;
  }

  async function doRegisterVerify(
    token: string,
    challengeKey: string,
    credId = FAKE_CRED_ID,
  ): Promise<string> {
    mockVerReg.mockResolvedValueOnce(fakeVerRegSuccess(credId));
    const verRes = await request(app)
      .post("/api/v1/auth/passkey/register/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({
        _challenge_key: challengeKey,
        response: {
          id: credId,
          rawId: credId,
          response: {
            clientDataJSON: "dGVzdA",
            attestationObject: "dGVzdA",
            transports: ["internal"],
          },
          clientExtensionResults: {},
          type: "public-key",
        },
        friendly_name: "My Key",
      });
    expect(verRes.status).toBe(200);
    return verRes.body.id;
  }

  async function doLoginOptions(email: string, challenge = FAKE_CHALLENGE): Promise<string> {
    mockGenAuth.mockResolvedValueOnce(fakeAuthOptions(challenge));
    const optRes = await request(app)
      .post("/api/v1/auth/passkey/login/options")
      .send({ email });
    expect(optRes.status).toBe(200);
    return optRes.body._challenge_key;
  }

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;
    await seedTestProject(db);
    app = createApp({ db });
    userA = await seedReviewer(db, app, { email: "passkey-a@test.com", role: "reviewer" });
    userB = await seedReviewer(db, app, { email: "passkey-b@test.com", role: "reviewer" });
  });

  afterAll(async () => {
    await client?.close();
    vi.restoreAllMocks();
  });

  // ── Scenario 1: Happy path ──────────────────────────────────────────────────
  describe("Scenario 1: happy path — register, list, login, counter updated", () => {
    const CHALLENGE_A = "aGFwcHlwYXRoY2hhbGxlbmdl"; // unique per scenario

    it("registers a passkey and returns verified=true + id", async () => {
      const challengeKey = await doRegisterOptions(userA.sessionToken, CHALLENGE_A);
      const passkeyId = await doRegisterVerify(userA.sessionToken, challengeKey);
      expect(passkeyId).toMatch(/^gw_pkey_/);
    });

    it("GET /account/passkeys lists the registered passkey", async () => {
      const res = await request(app)
        .get("/api/v1/account/passkeys")
        .set("Authorization", `Bearer ${userA.sessionToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
      const item = res.body.items.find((i: any) => i.friendly_name === "My Key");
      expect(item).toBeDefined();
      // Must NOT expose credential_id or public_key
      expect(item.credential_id).toBeUndefined();
      expect(item.public_key).toBeUndefined();
    });

    it("login/options succeeds for known email", async () => {
      const challengeKey = await doLoginOptions(userA.reviewer.email, CHALLENGE_A + "2");
      expect(challengeKey).toMatch(/^gw_pkey_/);
    });

    it("login/verify succeeds and counter is updated (0→5)", async () => {
      const challengeKey = await doLoginOptions(userA.reviewer.email, CHALLENGE_A + "3");
      mockVerAuth.mockResolvedValueOnce(fakeVerAuthSuccess(5));
      const res = await request(app)
        .post("/api/v1/auth/passkey/login/verify")
        .send({
          _challenge_key: challengeKey,
          response: {
            id: FAKE_CRED_ID,
            rawId: FAKE_CRED_ID,
            response: {
              clientDataJSON: "dGVzdA",
              authenticatorData: "dGVzdA",
              signature: "dGVzdA",
            },
            clientExtensionResults: {},
            type: "public-key",
          },
        });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.reviewer.email).toBe(userA.reviewer.email);

      // Verify counter was persisted as 5
      const [cred] = await db
        .select({ counter: webauthn_credentials.counter })
        .from(webauthn_credentials)
        .where(eq(webauthn_credentials.credential_id, FAKE_CRED_ID));
      expect(cred.counter).toBe(5);
    });
  });

  // ── Scenario 2: Replay rejection ───────────────────────────────────────────
  describe("Scenario 2: counter replay — newCounter (3) <= stored (5) → 401", () => {
    const CRED_ID_S2 = "cmVwbGF5Q3JlZElk"; // unique to this scenario
    const CHALLENGE_S2 = "cmVwbGF5Q2hhbGxlbmdl";

    beforeAll(async () => {
      // Register a credential for userA with credId unique to this scenario
      const challengeKey = await doRegisterOptions(userA.sessionToken, CHALLENGE_S2);
      mockVerReg.mockResolvedValueOnce(fakeVerRegSuccess(CRED_ID_S2));
      await request(app)
        .post("/api/v1/auth/passkey/register/verify")
        .set("Authorization", `Bearer ${userA.sessionToken}`)
        .send({
          _challenge_key: challengeKey,
          response: {
            id: CRED_ID_S2, rawId: CRED_ID_S2,
            response: { clientDataJSON: "dGVzdA", attestationObject: "dGVzdA", transports: [] },
            clientExtensionResults: {}, type: "public-key",
          },
          friendly_name: "Replay Test Key",
        });

      // Directly set its counter to 5 in DB
      await db
        .update(webauthn_credentials)
        .set({ counter: 5 })
        .where(eq(webauthn_credentials.credential_id, CRED_ID_S2));
    });

    it("rejects login when newCounter (3) <= storedCounter (5)", async () => {
      const challengeKey = await doLoginOptions(userA.reviewer.email, CHALLENGE_S2 + "login");
      // Mock verifyAuthenticationResponse to return verified=true but newCounter=3
      mockVerAuth.mockResolvedValueOnce(fakeVerAuthSuccess(3));

      const res = await request(app)
        .post("/api/v1/auth/passkey/login/verify")
        .send({
          _challenge_key: challengeKey,
          response: {
            id: CRED_ID_S2, rawId: CRED_ID_S2,
            response: { clientDataJSON: "dGVzdA", authenticatorData: "dGVzdA", signature: "dGVzdA" },
            clientExtensionResults: {}, type: "public-key",
          },
        });
      expect(res.status).toBe(401);
      // I2: all /login/verify 401s return the same collapsed code to prevent
      // credential enumeration via response-code probing. Reason is server-side only.
      expect(res.body.error?.code ?? res.body.code).toBe("passkey_login_failed");
    });
  });

  // ── Scenario 3: Wrong RP-ID / verification failure ─────────────────────────
  describe("Scenario 3: verifyAuthenticationResponse returns verified=false → 401", () => {
    const CRED_ID_S3 = "d3JvbmdScElkQ3JlZA";
    const CHALLENGE_S3 = "d3JvbmdScElkQ2hhbA";

    beforeAll(async () => {
      const challengeKey = await doRegisterOptions(userA.sessionToken, CHALLENGE_S3);
      mockVerReg.mockResolvedValueOnce(fakeVerRegSuccess(CRED_ID_S3));
      await request(app)
        .post("/api/v1/auth/passkey/register/verify")
        .set("Authorization", `Bearer ${userA.sessionToken}`)
        .send({
          _challenge_key: challengeKey,
          response: {
            id: CRED_ID_S3, rawId: CRED_ID_S3,
            response: { clientDataJSON: "dGVzdA", attestationObject: "dGVzdA", transports: [] },
            clientExtensionResults: {}, type: "public-key",
          },
          friendly_name: "Wrong RP Key",
        });
    });

    it("returns 401 when verifyAuthenticationResponse returns verified=false", async () => {
      const challengeKey = await doLoginOptions(userA.reviewer.email, CHALLENGE_S3 + "login");
      // Simulate library returning verified=false (e.g. RP-ID mismatch)
      mockVerAuth.mockResolvedValueOnce({
        verified: false,
        authenticationInfo: {
          credentialID: CRED_ID_S3,
          newCounter: 1,
          userVerified: false,
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false,
          origin: "http://evil.example.com",
          rpID: "evil.example.com",
        },
      });

      const res = await request(app)
        .post("/api/v1/auth/passkey/login/verify")
        .send({
          _challenge_key: challengeKey,
          response: {
            id: CRED_ID_S3, rawId: CRED_ID_S3,
            response: { clientDataJSON: "dGVzdA", authenticatorData: "dGVzdA", signature: "dGVzdA" },
            clientExtensionResults: {}, type: "public-key",
          },
        });
      expect(res.status).toBe(401);
    });
  });

  // ── Scenario 4: Wrong-user cross-credential ────────────────────────────────
  describe("Scenario 4: credential registered to userA, login challenge for userB → 401", () => {
    const CRED_ID_S4 = "d3JvbmdVc2VyQ3JlZA";
    const CHALLENGE_S4 = "d3JvbmdVc2VyQ2hhbA";

    beforeAll(async () => {
      // Register credential CRED_ID_S4 under userA
      const challengeKey = await doRegisterOptions(userA.sessionToken, CHALLENGE_S4);
      mockVerReg.mockResolvedValueOnce(fakeVerRegSuccess(CRED_ID_S4));
      await request(app)
        .post("/api/v1/auth/passkey/register/verify")
        .set("Authorization", `Bearer ${userA.sessionToken}`)
        .send({
          _challenge_key: challengeKey,
          response: {
            id: CRED_ID_S4, rawId: CRED_ID_S4,
            response: { clientDataJSON: "dGVzdA", attestationObject: "dGVzdA", transports: [] },
            clientExtensionResults: {}, type: "public-key",
          },
          friendly_name: "UserA Key",
        });
    });

    it("returns 401 when submitting userA credential for userB challenge", async () => {
      // Get login options/challenge for userB
      const challengeKey = await doLoginOptions(userB.reviewer.email, CHALLENGE_S4 + "login");

      // Submit userA's credential_id — it won't be found for userB's challenge reviewer
      // (the challenge maps to userB's id, but CRED_ID_S4 belongs to userA)
      const res = await request(app)
        .post("/api/v1/auth/passkey/login/verify")
        .send({
          _challenge_key: challengeKey,
          response: {
            id: CRED_ID_S4, rawId: CRED_ID_S4,
            response: { clientDataJSON: "dGVzdA", authenticatorData: "dGVzdA", signature: "dGVzdA" },
            clientExtensionResults: {}, type: "public-key",
          },
        });
      expect(res.status).toBe(401);
    });
  });

  // ── Scenario 5: Counter=0 Apple edge case ─────────────────────────────────
  describe("Scenario 5: both counters 0 (Apple authenticator quirk) → accept", () => {
    const CRED_ID_S5 = "YXBwbGVDcmVkSWQ";
    const CHALLENGE_S5 = "YXBwbGVDaGFsbGVuZ2U";

    beforeAll(async () => {
      const challengeKey = await doRegisterOptions(userA.sessionToken, CHALLENGE_S5);
      // Register with counter=0
      mockVerReg.mockResolvedValueOnce({
        ...fakeVerRegSuccess(CRED_ID_S5),
        registrationInfo: {
          ...fakeVerRegSuccess(CRED_ID_S5).registrationInfo,
          credential: {
            id: CRED_ID_S5,
            publicKey: FAKE_PUB_KEY,
            counter: 0, // Apple: starts at 0
            transports: ["internal"],
          },
        },
      });
      await request(app)
        .post("/api/v1/auth/passkey/register/verify")
        .set("Authorization", `Bearer ${userA.sessionToken}`)
        .send({
          _challenge_key: challengeKey,
          response: {
            id: CRED_ID_S5, rawId: CRED_ID_S5,
            response: { clientDataJSON: "dGVzdA", attestationObject: "dGVzdA", transports: [] },
            clientExtensionResults: {}, type: "public-key",
          },
          friendly_name: "Apple Key",
        });
    });

    it("accepts login when both storedCounter and newCounter are 0", async () => {
      const challengeKey = await doLoginOptions(userA.reviewer.email, CHALLENGE_S5 + "login");
      // Apple authenticator: returns newCounter=0
      mockVerAuth.mockResolvedValueOnce(fakeVerAuthSuccess(0));

      const res = await request(app)
        .post("/api/v1/auth/passkey/login/verify")
        .send({
          _challenge_key: challengeKey,
          response: {
            id: CRED_ID_S5, rawId: CRED_ID_S5,
            response: { clientDataJSON: "dGVzdA", authenticatorData: "dGVzdA", signature: "dGVzdA" },
            clientExtensionResults: {}, type: "public-key",
          },
        });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
    });
  });

  // ── Scenario 6: Delete revokes ─────────────────────────────────────────────
  describe("Scenario 6: delete a passkey, subsequent login returns 401", () => {
    const CRED_ID_S6 = "ZGVsZXRlZENyZWRJZA";
    const CHALLENGE_S6 = "ZGVsZXRlQ2hhbGxlbmdl";
    let passkeyId: string;

    it("registers passkey successfully", async () => {
      const challengeKey = await doRegisterOptions(userA.sessionToken, CHALLENGE_S6);
      mockVerReg.mockResolvedValueOnce(fakeVerRegSuccess(CRED_ID_S6));
      const verRes = await request(app)
        .post("/api/v1/auth/passkey/register/verify")
        .set("Authorization", `Bearer ${userA.sessionToken}`)
        .send({
          _challenge_key: challengeKey,
          response: {
            id: CRED_ID_S6, rawId: CRED_ID_S6,
            response: { clientDataJSON: "dGVzdA", attestationObject: "dGVzdA", transports: [] },
            clientExtensionResults: {}, type: "public-key",
          },
          friendly_name: "To Be Deleted",
        });
      expect(verRes.status).toBe(200);
      passkeyId = verRes.body.id;
    });

    it("DELETE /account/passkeys/:id returns deleted=true", async () => {
      const res = await request(app)
        .delete(`/api/v1/account/passkeys/${passkeyId}`)
        .set("Authorization", `Bearer ${userA.sessionToken}`);
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });

    it("login with deleted credential returns 401", async () => {
      // Get a fresh login challenge for userA — credential is deleted from DB
      const challengeKey = await doLoginOptions(userA.reviewer.email, CHALLENGE_S6 + "login");
      // verifyAuthenticationResponse would succeed, but credential_id won't be in DB
      mockVerAuth.mockResolvedValueOnce(fakeVerAuthSuccess(1));

      const res = await request(app)
        .post("/api/v1/auth/passkey/login/verify")
        .send({
          _challenge_key: challengeKey,
          response: {
            id: CRED_ID_S6, rawId: CRED_ID_S6,
            response: { clientDataJSON: "dGVzdA", authenticatorData: "dGVzdA", signature: "dGVzdA" },
            clientExtensionResults: {}, type: "public-key",
          },
        });
      expect(res.status).toBe(401);
    });
  });

  // ── Scenario 7: cross-user DELETE IDOR check (I5) ─────────────────────────
  // Verifies that the DELETE endpoint enforces ownership — userB cannot delete
  // a passkey owned by userA. The route already enforces this; this test
  // prevents regression.
  describe("Scenario 7: cross-user DELETE — userB cannot delete userA's passkey", () => {
    const CRED_ID_S7 = "Y3Jvc3NVc2VyRGVsZXRl"; // "crossUserDelete"
    const CHALLENGE_S7 = "Y3Jvc3NVc2VyQ2hhbA";
    let passkeyIdS7: string;

    beforeAll(async () => {
      // Register a passkey for userA
      const challengeKey = await doRegisterOptions(userA.sessionToken, CHALLENGE_S7);
      mockVerReg.mockResolvedValueOnce(fakeVerRegSuccess(CRED_ID_S7));
      const verRes = await request(app)
        .post("/api/v1/auth/passkey/register/verify")
        .set("Authorization", `Bearer ${userA.sessionToken}`)
        .send({
          _challenge_key: challengeKey,
          response: {
            id: CRED_ID_S7, rawId: CRED_ID_S7,
            response: { clientDataJSON: "dGVzdA", attestationObject: "dGVzdA", transports: [] },
            clientExtensionResults: {}, type: "public-key",
          },
          friendly_name: "UserA IDOR Test Key",
        });
      expect(verRes.status).toBe(200);
      passkeyIdS7 = verRes.body.id;
    });

    it("userB cannot delete userA's passkey (returns 404, credential still exists)", async () => {
      // userB attempts DELETE on userA's passkey
      const res = await request(app)
        .delete(`/api/v1/account/passkeys/${passkeyIdS7}`)
        .set("Authorization", `Bearer ${userB.sessionToken}`);

      // Route enforces ownership via AND(id=passkeyId, user_id=reviewer.id) → 0 rows → 404
      expect(res.status).toBe(404);

      // Confirm the credential still exists in the DB, owned by userA
      const [stillExists] = await db
        .select({ id: webauthn_credentials.id, user_id: webauthn_credentials.user_id })
        .from(webauthn_credentials)
        .where(eq(webauthn_credentials.id, passkeyIdS7));
      expect(stillExists).toBeDefined();
      expect(stillExists.user_id).toBe(userA.reviewer.id);
    });
  });

  // ── Scenario 8: expired challenge TTL (I6) ────────────────────────────────
  // Advances time past the 5-minute challenge TTL via vi.useFakeTimers to
  // verify /login/verify returns 401 for stale challenges.
  describe("Scenario 8: expired challenge — TTL exceeded", () => {
    it("returns 401 when the challenge is older than 5 minutes", async () => {
      vi.useFakeTimers();
      try {
        // Get a challenge for userA
        mockGenAuth.mockResolvedValueOnce(fakeAuthOptions("expiredchallenge123"));
        const optRes = await request(app)
          .post("/api/v1/auth/passkey/login/options")
          .send({ email: userA.reviewer.email });
        expect(optRes.status).toBe(200);
        const challengeKey = optRes.body._challenge_key;

        // Advance time by 6 minutes (past the 5-minute CHALLENGE_TTL_MS)
        vi.advanceTimersByTime(6 * 60 * 1000 + 1000);

        // Attempt verify with the stale challenge
        const verifyRes = await request(app)
          .post("/api/v1/auth/passkey/login/verify")
          .send({
            _challenge_key: challengeKey,
            response: {
              id: FAKE_CRED_ID,
              rawId: FAKE_CRED_ID,
              response: { clientDataJSON: "dGVzdA", authenticatorData: "dGVzdA", signature: "dGVzdA" },
              clientExtensionResults: {},
              type: "public-key",
            },
          });

        expect(verifyRes.status).toBe(401);
        // I2: collapsed code — all /login/verify 401s return passkey_login_failed
        expect(verifyRes.body.error?.code ?? verifyRes.body.code).toBe("passkey_login_failed");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Scenario 7: malformed input types ──────────────────────────────────────
  describe("Scenario 7: malformed input types are rejected before any lookup", () => {
    it("register/verify: object _challenge_key → missing_params", async () => {
      const res = await request(app)
        .post("/api/v1/auth/passkey/register/verify")
        .set("Authorization", `Bearer ${userA.sessionToken}`)
        .send({ _challenge_key: { k: 1 }, response: { type: "public-key" } });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("missing_params");
    });

    it("register/verify: string response → missing_params", async () => {
      const res = await request(app)
        .post("/api/v1/auth/passkey/register/verify")
        .set("Authorization", `Bearer ${userA.sessionToken}`)
        .send({ _challenge_key: "gw_pkey_nonexistent", response: "not-an-object" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("missing_params");
    });

    it("login/verify: object _challenge_key → missing_params", async () => {
      const res = await request(app)
        .post("/api/v1/auth/passkey/login/verify")
        .send({ _challenge_key: { k: 1 }, response: { type: "public-key" } });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("missing_params");
    });

    it("register/options: object friendly_name is coerced to empty string in the echo", async () => {
      mockGenReg.mockResolvedValueOnce(fakeRegOptions("bWFsZm9ybWVkbmFtZQ"));
      const res = await request(app)
        .post("/api/v1/auth/passkey/register/options")
        .set("Authorization", `Bearer ${userA.sessionToken}`)
        .send({ friendly_name: { evil: true } });
      expect(res.status).toBe(200);
      expect(res.body._friendly_name).toBe("");
    });

    it("register/verify: >100-char friendly_name is persisted truncated to 100", async () => {
      const longName = "x".repeat(150);
      const CRED_ID_S7 = "dHJ1bmNhdGVDcmVkSWQ";
      mockGenReg.mockResolvedValueOnce(fakeRegOptions("dHJ1bmNhdGVjaGFsbGVuZ2U"));
      const optRes = await request(app)
        .post("/api/v1/auth/passkey/register/options")
        .set("Authorization", `Bearer ${userB.sessionToken}`)
        .send({ friendly_name: longName });
      expect(optRes.status).toBe(200);
      mockVerReg.mockResolvedValueOnce(fakeVerRegSuccess(CRED_ID_S7));
      const verRes = await request(app)
        .post("/api/v1/auth/passkey/register/verify")
        .set("Authorization", `Bearer ${userB.sessionToken}`)
        .send({
          _challenge_key: optRes.body._challenge_key,
          response: {
            id: CRED_ID_S7,
            rawId: CRED_ID_S7,
            response: { clientDataJSON: "dGVzdA", attestationObject: "dGVzdA", transports: ["internal"] },
            clientExtensionResults: {},
            type: "public-key",
          },
          friendly_name: longName,
        });
      expect(verRes.status).toBe(200);
      const [cred] = await db
        .select({ friendly_name: webauthn_credentials.friendly_name })
        .from(webauthn_credentials)
        .where(eq(webauthn_credentials.credential_id, CRED_ID_S7));
      expect(cred.friendly_name).toBe("x".repeat(100));
    });
  });
});

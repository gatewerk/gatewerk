import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb } from "./helpers/test-db";

/**
 * Provider callbacks must not be claimed by dualAuth.
 *
 * Stripe and Resend authenticate by signing their payload, not by presenting
 * an API key or a session. Their routers are mounted by ee/bootstrap.ts, which
 * registerEE runs AFTER the /api/v1 dualRouter — so before the exemption in
 * app.ts, dualAuth matched first and answered 401 missing_credentials. Both
 * handlers were unreachable in cloud production and nothing surfaced it:
 * Resend logged a failing endpoint, the API logged a 401, and the operator saw
 * an empty suppression list. The Stripe path had the same hole, which would
 * have meant a completed checkout never activating a subscription.
 *
 * These assertions are deliberately "not 401" rather than a specific success
 * code: this suite builds the app without the EE bundle, so the callback paths
 * fall through to the 404 handler. A 404 still proves the auth layer let go of
 * the request, which is the whole claim. Asserting 200 would require mounting
 * ee/ and would test the handlers instead of the gate.
 */
describe("signed provider callbacks are exempt from dualAuth", () => {
  let app: any;

  beforeAll(async () => {
    const { db } = await createTestDb();
    app = createApp({ db } as any);
  });

  for (const path of ["/api/v1/webhooks/stripe", "/api/v1/webhooks/resend"]) {
    it(`does not answer 401 on ${path} without credentials`, async () => {
      const res = await request(app).post(path).send({});
      expect(res.status).not.toBe(401);
      expect(res.body?.error?.code).not.toBe("missing_credentials");
    });
  }

  // The exemption is an exact-path Set, never a prefix, because this route
  // lives under the same /api/v1/webhooks/ segment and is an authenticated
  // admin surface. A startsWith() check would have opened it to the world.
  it("still requires credentials on /api/v1/webhooks/deliveries", async () => {
    const res = await request(app).get("/api/v1/webhooks/deliveries");
    expect(res.status).toBe(401);
  });

  // Prefix confusion in the other direction: a path that merely begins with an
  // exempt one must not inherit the exemption.
  it("does not exempt a path that only starts with an exempt one", async () => {
    const res = await request(app).post("/api/v1/webhooks/stripe/extra").send({});
    expect(res.status).toBe(401);
  });
});

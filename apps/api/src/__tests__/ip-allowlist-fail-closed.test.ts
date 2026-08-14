import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { apiKeys, reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import bcrypt from "bcryptjs";
import { createApp } from "../app";
import { ipMatchesAllowlist } from "../lib/auth-helpers";
import { createTestDb, seedTestProject } from "./helpers/test-db";

// Regression lock for §5 F6 (ip-allowlist-brittleness). Pins two invariants
// that together ensure malformed entries never widen the allowlist:
//
//   1. Runtime (ipMatchesAllowlist): returns false whenever no VALID entry
//      matches the caller IP. Malformed entries are silently skipped, but
//      the BlockList is populated only from valid entries — an empty or
//      reduced BlockList returns false for every query, so silent-skip
//      never flips to "allow all." This is the fail-closed property.
//
//   2. Write-path (POST / PATCH /api/v1/settings/api-keys): rejects
//      malformed CIDR entries loudly with 400 invalid_ip_allowlist before
//      the row is written. This is the "loud at init" defense that should
//      normally prevent malformed entries from ever reaching runtime.
//
// The combination means: malformed entries cannot be stored under normal
// operation; if they ever reach runtime (DB drift, direct DB edit, or a
// future refactor flipping the BlockList semantic), the runtime invariant
// keeps the allowlist from widening.

describe("F6 — ipMatchesAllowlist fail-closed on malformed (unit)", () => {
  it("returns false for an empty allowlist", () => {
    expect(ipMatchesAllowlist("127.0.0.1", [])).toBe(false);
    expect(ipMatchesAllowlist("10.1.2.3", [])).toBe(false);
    expect(ipMatchesAllowlist("::1", [])).toBe(false);
  });

  it("returns false when every entry is malformed (no valid entries to match against)", () => {
    const malformed = ["not-an-ip", "garbage", "300.1.1.1", "10.0.0.0/99", "foo/bar"];
    expect(ipMatchesAllowlist("127.0.0.1", malformed)).toBe(false);
    expect(ipMatchesAllowlist("10.0.0.1", malformed)).toBe(false);
    expect(ipMatchesAllowlist("2001:db8::1", malformed)).toBe(false);
  });

  it("returns false when ip does not match any valid entry (malformed entries do not widen)", () => {
    expect(ipMatchesAllowlist("127.0.0.1", ["10.0.0.0/8", "not-an-ip"])).toBe(false);
    expect(ipMatchesAllowlist("8.8.8.8", ["192.168.0.0/16", "10.0.0.0/99", "garbage"])).toBe(false);
  });

  it("returns true when ip matches a valid entry (valid still works through noise)", () => {
    expect(ipMatchesAllowlist("127.0.0.1", ["127.0.0.0/8", "not-an-ip"])).toBe(true);
    expect(ipMatchesAllowlist("10.1.2.3", ["garbage", "10.0.0.0/8"])).toBe(true);
    expect(ipMatchesAllowlist("192.168.1.50", ["10.0.0.0/99", "192.168.0.0/16"])).toBe(true);
  });

  it("rejects empty strings and whitespace-only entries without widening", () => {
    expect(ipMatchesAllowlist("127.0.0.1", [""])).toBe(false);
    expect(ipMatchesAllowlist("127.0.0.1", ["", " ", "\t"])).toBe(false);
    expect(ipMatchesAllowlist("127.0.0.1", ["", "127.0.0.0/8"])).toBe(true);
  });

  it("normalizes IPv4-mapped IPv6 client IP and evaluates against v4 entries (malformed siblings ignored)", () => {
    // `::ffff:127.0.0.1` is how a dual-stack socket exposes an IPv4 client.
    // The function normalizes to the plain v4 address before matching.
    expect(ipMatchesAllowlist("::ffff:127.0.0.1", ["127.0.0.0/8", "bogus"])).toBe(true);
    expect(ipMatchesAllowlist("::ffff:10.0.0.1", ["192.168.0.0/16", "bogus"])).toBe(false);
  });

  it("rejects a client IP that itself fails isIP(), regardless of allowlist contents", () => {
    expect(ipMatchesAllowlist("not-an-ip", ["127.0.0.0/8"])).toBe(false);
    expect(ipMatchesAllowlist("", ["127.0.0.0/8", "garbage"])).toBe(false);
  });
});

describe("F6 — middleware end-to-end (simulated DB drift)", () => {
  it("returns 401 ip_not_allowed when DB row carries only malformed ip_allowlist entries", async () => {
    // Simulates the DB-drift scenario: somehow (direct edit, schema
    // migration bug, corrupted backup) an api_keys row ends up with
    // ip_allowlist populated entirely from malformed entries. The
    // middleware sees length > 0 and calls ipMatchesAllowlist, which
    // returns false — request is rejected, not silently admitted.
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const hash = createHash("sha256").update(seed.apiKey).digest("hex");

    await db
      .update(apiKeys)
      .set({ ip_allowlist: ["not-an-ip", "300.300.300.300", "10.0.0.0/99"] })
      .where(eq(apiKeys.key_hash, hash));

    const app = createApp({ db });
    const res = await request(app)
      .get("/api/v1/templates")
      .set("Authorization", `Bearer ${seed.apiKey}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ip_not_allowed");
  });
});

describe("F6 — write-path rejects malformed CIDR loudly", () => {
  let app: any;
  let db: any;
  let sessionToken: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    await seedTestProject(db);

    await db.insert(reviewers).values({
      id: generateId("user"),
      email: "admin@gatewerk.local",
      name: "Admin",
      password_hash: await bcrypt.hash("admin123", 10),
      role: "admin",
    });

    app = createApp({ db });

    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@gatewerk.local", password: "admin123" });

    sessionToken = loginRes.body.token;
  });

  const sessionAuth = () => ({ Authorization: `Bearer ${sessionToken}` });

  it("POST rejects a non-IP string with 400 invalid_ip_allowlist", async () => {
    const res = await request(app)
      .post("/api/v1/settings/api-keys")
      .set(sessionAuth())
      .send({
        name: "F6 write-path not-an-ip",
        scopes: ["reviews:create"],
        ip_allowlist: ["not-an-ip"],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_ip_allowlist");
  });

  it("POST rejects a malformed prefix with 400 invalid_ip_allowlist", async () => {
    const res = await request(app)
      .post("/api/v1/settings/api-keys")
      .set(sessionAuth())
      .send({
        name: "F6 write-path bad-prefix",
        scopes: ["reviews:create"],
        ip_allowlist: ["10.0.0.0/99"],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_ip_allowlist");
  });

  it("POST rejects a mix of valid + malformed entries (any malformed fails the batch)", async () => {
    const res = await request(app)
      .post("/api/v1/settings/api-keys")
      .set(sessionAuth())
      .send({
        name: "F6 write-path mixed",
        scopes: ["reviews:create"],
        ip_allowlist: ["10.0.0.0/8", "garbage", "192.168.0.0/16"],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_ip_allowlist");
  });

  it("PUT rejects malformed entries in an update body with 400 invalid_ip_allowlist", async () => {
    const createRes = await request(app)
      .post("/api/v1/settings/api-keys")
      .set(sessionAuth())
      .send({
        name: "F6 update target",
        scopes: ["reviews:create"],
      });
    expect(createRes.status).toBe(201);
    const keyId = createRes.body.id;

    const putRes = await request(app)
      .put(`/api/v1/settings/api-keys/${keyId}`)
      .set(sessionAuth())
      .send({ ip_allowlist: ["not-an-ip"] });

    expect(putRes.status).toBe(400);
    expect(putRes.body.error.code).toBe("invalid_ip_allowlist");
  });

  it("POST accepts well-formed IPv4, IPv6, and CIDR entries (negative confirmation)", async () => {
    const res = await request(app)
      .post("/api/v1/settings/api-keys")
      .set(sessionAuth())
      .send({
        name: "F6 write-path well-formed",
        scopes: ["reviews:create"],
        ip_allowlist: ["127.0.0.1", "10.0.0.0/8", "::1", "2001:db8::/32"],
      });

    expect(res.status).toBe(201);
    expect(res.body.ip_allowlist).toEqual(["127.0.0.1", "10.0.0.0/8", "::1", "2001:db8::/32"]);
  });
});

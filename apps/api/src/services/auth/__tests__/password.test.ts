import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../password";
import bcrypt from "bcryptjs";

describe("hashPassword", () => {
  it("produces an argon2id hash", async () => {
    const hash = await hashPassword("hunter2");
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it("produces different hashes for the same input (random salt)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });
});

describe("verifyPassword — argon2id path", () => {
  it("returns valid=true, needsRehash=false for correct argon2id password", async () => {
    const hash = await hashPassword("correct-horse");
    const result = await verifyPassword(hash, "correct-horse");
    expect(result.valid).toBe(true);
    expect(result.needsRehash).toBe(false);
  });

  it("returns valid=false, needsRehash=false for wrong password against argon2id hash", async () => {
    const hash = await hashPassword("correct-horse");
    const result = await verifyPassword(hash, "wrong-horse");
    expect(result.valid).toBe(false);
    expect(result.needsRehash).toBe(false);
  });
});

describe("verifyPassword — corrupted argon2id hash", () => {
  it("returns valid=false, needsRehash=false for a corrupted $argon2id$ hash (no throw)", async () => {
    const result = await verifyPassword("$argon2id$v=19$m=19456,t=2,p=1$TRUNCATED", "any-password");
    expect(result.valid).toBe(false);
    expect(result.needsRehash).toBe(false);
  });
});

describe("verifyPassword — bcrypt-fallback path", () => {
  it("returns valid=true, needsRehash=true for correct password against bcrypt hash", async () => {
    const legacyHash = await bcrypt.hash("legacy-pass", 10);
    const result = await verifyPassword(legacyHash, "legacy-pass");
    expect(result.valid).toBe(true);
    expect(result.needsRehash).toBe(true);
  });

  it("returns valid=false, needsRehash=false for wrong password against bcrypt hash", async () => {
    const legacyHash = await bcrypt.hash("legacy-pass", 10);
    const result = await verifyPassword(legacyHash, "wrong-pass");
    expect(result.valid).toBe(false);
    // needsRehash=false because wrong password — no point signalling rehash
    expect(result.needsRehash).toBe(false);
  });
});

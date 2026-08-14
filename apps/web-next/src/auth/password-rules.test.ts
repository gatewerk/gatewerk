/**
 * The two rules the old screens got wrong.
 *
 * 1. apps/web's ResetPassword validated at 8 characters and enabled its submit
 *    button at 8, while POST /reset-password has required 12 since
 *    password-policy.ts was written. A reviewer typing 9 characters was told
 *    the password was fine, and then told by the server that it was not.
 * 2. Both password screens compare against a confirm field. Reporting
 *    "passwords do not match" for a password that is also too short sends the
 *    reviewer to fix the wrong field.
 *
 * These assert against PASSWORD_MIN/PASSWORD_MAX rather than literals so the
 * test tracks the constants, but the boundary cases below are written out at
 * their real values so a silent loosening of the policy fails here.
 */

import { describe, it, expect } from "vitest";
import {
  canSubmitPassword,
  checkPassword,
  checkPasswordPair,
  inviteStateFromError,
} from "./password-rules";
import { PASSWORD_MAX, PASSWORD_MIN } from "./auth-copy";

const pw = (n: number) => "a".repeat(n);

describe("checkPassword", () => {
  it("mirrors the server's minimum of 12", () => {
    expect(PASSWORD_MIN).toBe(12);
  });

  it("rejects the length apps/web used to accept", () => {
    // The exact regression: 8 through 11 characters passed apps/web's form.
    for (const n of [8, 9, 10, 11]) {
      expect(checkPassword(pw(n))).toEqual({ ok: false, reason: "short" });
    }
  });

  it("accepts exactly the minimum", () => {
    expect(checkPassword(pw(PASSWORD_MIN))).toEqual({ ok: true });
  });

  it("rejects one character below the minimum", () => {
    expect(checkPassword(pw(PASSWORD_MIN - 1))).toEqual({ ok: false, reason: "short" });
  });

  it("accepts exactly the maximum and rejects one above", () => {
    expect(checkPassword(pw(PASSWORD_MAX))).toEqual({ ok: true });
    expect(checkPassword(pw(PASSWORD_MAX + 1))).toEqual({ ok: false, reason: "long" });
  });

  it("treats an empty password as short rather than valid", () => {
    expect(checkPassword("")).toEqual({ ok: false, reason: "short" });
  });
});

describe("checkPasswordPair", () => {
  it("accepts a long enough password that matches", () => {
    expect(checkPasswordPair(pw(14), pw(14))).toEqual({ ok: true });
  });

  it("reports a mismatch when both are long enough", () => {
    expect(checkPasswordPair(pw(14), pw(15))).toEqual({ ok: false, reason: "mismatch" });
  });

  it("reports length before mismatch, so the reviewer fixes the real problem", () => {
    // Short AND mismatched. "mismatch" here would point at the wrong field.
    expect(checkPasswordPair(pw(9), pw(10))).toEqual({ ok: false, reason: "short" });
  });

  it("does not accept two matching but too-short passwords", () => {
    expect(checkPasswordPair(pw(9), pw(9))).toEqual({ ok: false, reason: "short" });
  });
});

describe("canSubmitPassword", () => {
  it("is false at the length apps/web enabled its button", () => {
    expect(canSubmitPassword(pw(8))).toBe(false);
  });

  it("is true at the minimum with no confirm field", () => {
    expect(canSubmitPassword(pw(PASSWORD_MIN))).toBe(true);
  });

  it("requires the confirm field to agree when there is one", () => {
    expect(canSubmitPassword(pw(14), pw(14))).toBe(true);
    expect(canSubmitPassword(pw(14), "")).toBe(false);
    expect(canSubmitPassword(pw(14), pw(13))).toBe(false);
  });
});

describe("inviteStateFromError", () => {
  it("maps a used invite", () => {
    expect(inviteStateFromError(new Error("This invite has already been used"))).toBe("used");
  });

  it("maps an expired invite", () => {
    expect(inviteStateFromError(new Error("Invite has expired"))).toBe("expired");
  });

  it("maps a 404 to an invalid link", () => {
    const err = Object.assign(new Error("Not Found"), { status: 404 });
    expect(inviteStateFromError(err)).toBe("invalid");
  });

  it("falls back to error for anything unrecognised", () => {
    expect(inviteStateFromError(new Error("boom"))).toBe("error");
    expect(inviteStateFromError(null)).toBe("error");
    expect(inviteStateFromError(undefined)).toBe("error");
    expect(inviteStateFromError("a string")).toBe("error");
  });

  it("prefers the message over the status when both are present", () => {
    // A used invite that also carries a 404 is still a used invite: the
    // reviewer needs "sign in instead", not "ask for a new link".
    const err = Object.assign(new Error("already been used"), { status: 404 });
    expect(inviteStateFromError(err)).toBe("used");
  });
});

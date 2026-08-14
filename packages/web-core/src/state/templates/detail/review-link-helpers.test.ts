import { describe, it, expect } from "vitest";
import {
  coerceAuthLevel,
  coerceExpirySeconds,
  resolveReviewLinkFields,
  buildReviewLinkDraftFields,
} from "./review-link-helpers";

// Coerce helper coverage — ported from template-editor/_helpers.test.ts
// (only the coerce-related cases; toFormState/formToPayload live in the orphaned tree).

describe("coerceAuthLevel", () => {
  it("passes through email_otp", () => {
    expect(coerceAuthLevel("email_otp")).toBe("email_otp");
  });
  it("passes through account", () => {
    expect(coerceAuthLevel("account")).toBe("account");
  });
  it("coerces unknown string back to public (forward-compat)", () => {
    expect(coerceAuthLevel("future_tier")).toBe("public");
  });
  it("coerces undefined to public", () => {
    expect(coerceAuthLevel(undefined)).toBe("public");
  });
  it("coerces null to public", () => {
    expect(coerceAuthLevel(null)).toBe("public");
  });
});

describe("coerceExpirySeconds", () => {
  it("passes through valid integer in range", () => {
    expect(coerceExpirySeconds(86400)).toBe(86400);
    expect(coerceExpirySeconds(604800)).toBe(604800);
    expect(coerceExpirySeconds(2592000)).toBe(2592000);
  });

  const INVALID: Array<{ input: unknown; label: string }> = [
    { input: 0, label: "zero" },
    { input: -1, label: "negative" },
    { input: 9999999, label: "over max" },
    { input: 1.5, label: "float" },
    { input: "604800", label: "string" },
    { input: undefined, label: "undefined" },
    { input: null, label: "null" },
  ];

  for (const { input, label } of INVALID) {
    it(`coerces ${label} to TEMPLATE_DEFAULT (86400)`, () => {
      expect(coerceExpirySeconds(input)).toBe(86400);
    });
  }
});

// resolveReviewLinkFields — tests that the draft>column>fallback precedence is
// exercised against the REAL helper (not a vacuous inline copy).
describe("resolveReviewLinkFields — draft>column>fallback", () => {
  it("reads all 3 fields from draft when draft is present", () => {
    const result = resolveReviewLinkFields(
      { enable_review_links: true, default_auth_level: "account", default_expiry_seconds: 604800 },
      { enable_review_links: false, default_auth_level: "public", default_expiry_seconds: 86400 },
    );
    expect(result.enableReviewLinks).toBe(true);
    expect(result.defaultAuthLevel).toBe("account");
    expect(result.defaultExpirySeconds).toBe(604800);
  });

  it("falls through to column when draft field is missing", () => {
    const result = resolveReviewLinkFields(
      { enable_review_links: undefined }, // missing auth + expiry in draft
      { enable_review_links: true, default_auth_level: "email_otp", default_expiry_seconds: 2592000 },
    );
    expect(result.enableReviewLinks).toBe(true);
    expect(result.defaultAuthLevel).toBe("email_otp");
    expect(result.defaultExpirySeconds).toBe(2592000);
  });

  it("applies fallbacks when both draft and column are absent", () => {
    const result = resolveReviewLinkFields(
      { enable_review_links: undefined },
      {},
    );
    expect(result.enableReviewLinks).toBe(false);
    expect(result.defaultAuthLevel).toBe("public");
    expect(result.defaultExpirySeconds).toBe(86400);
  });

  it("coerces invalid auth_level from draft back to public", () => {
    const result = resolveReviewLinkFields(
      { default_auth_level: "future_tier" },
      { default_auth_level: "account" },
    );
    expect(result.defaultAuthLevel).toBe("public");
  });

  it("coerces invalid expiry_seconds from draft back to TEMPLATE_DEFAULT", () => {
    const result = resolveReviewLinkFields(
      { default_expiry_seconds: -5 },
      { default_expiry_seconds: 604800 },
    );
    expect(result.defaultExpirySeconds).toBe(86400);
  });

  it("draft false overrides column true; auth/expiry still read", () => {
    const result = resolveReviewLinkFields(
      { enable_review_links: false },
      { enable_review_links: true, default_auth_level: "email_otp", default_expiry_seconds: 604800 },
    );
    expect(result.enableReviewLinks).toBe(false);
    expect(result.defaultAuthLevel).toBe("email_otp");
    expect(result.defaultExpirySeconds).toBe(604800);
  });

  it("reads from column only when draft is null", () => {
    const result = resolveReviewLinkFields(null, {
      enable_review_links: true,
      default_auth_level: "email_otp",
      default_expiry_seconds: 2592000,
    });
    expect(result.enableReviewLinks).toBe(true);
    expect(result.defaultAuthLevel).toBe("email_otp");
    expect(result.defaultExpirySeconds).toBe(2592000);
  });
});

// buildReviewLinkDraftFields — confirms exact key spellings (load-bearing for
// DraftConfigSchema passthrough; typos silently strand values).
describe("buildReviewLinkDraftFields — key names and round-trip", () => {
  it("emits exactly enable_review_links / default_auth_level / default_expiry_seconds", () => {
    const out = buildReviewLinkDraftFields({
      enableReviewLinks: true,
      defaultAuthLevel: "email_otp",
      defaultExpirySeconds: 604800,
    });
    expect(Object.keys(out)).toEqual([
      "enable_review_links",
      "default_auth_level",
      "default_expiry_seconds",
    ]);
    expect(out.enable_review_links).toBe(true);
    expect(out.default_auth_level).toBe("email_otp");
    expect(out.default_expiry_seconds).toBe(604800);
  });

  it("preserves auth/expiry state even when enableReviewLinks is false (C2 toggle-survive)", () => {
    const out = buildReviewLinkDraftFields({
      enableReviewLinks: false,
      defaultAuthLevel: "account",
      defaultExpirySeconds: 2592000,
    });
    expect(out.enable_review_links).toBe(false);
    expect(out.default_auth_level).toBe("account");
    expect(out.default_expiry_seconds).toBe(2592000);
  });
});

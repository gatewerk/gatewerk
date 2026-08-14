import { describe, it, expect } from "vitest";
import { ApiError } from "../../api/client/http";
import {
  buildSubmitErrorOutcome,
  validateQuestionText,
  QUESTION_TEXT_LIMITS,
} from "./recipient-actions-state";

// Pure-state coverage for the RecipientActions error-mapping +
// validation helpers. apps/web has no jsdom; component-render coverage
// for the modal lives in Playwright.

describe("buildSubmitErrorOutcome — error code mapping", () => {
  it("R1: 410 → invalidate + close, no inline message", () => {
    const err = new ApiError(410, "Gone", "token_already_used");
    const outcome = buildSubmitErrorOutcome(err);
    expect(outcome.shouldInvalidate).toBe(true);
    expect(outcome.shouldClose).toBe(true);
    expect(outcome.message).toBe("");
  });

  it("R2: 401 email_otp_required → invalidate + close", () => {
    const err = new ApiError(401, "Verify email", "email_otp_required");
    const outcome = buildSubmitErrorOutcome(err);
    expect(outcome.shouldInvalidate).toBe(true);
    expect(outcome.shouldClose).toBe(true);
    expect(outcome.message).toBe("");
  });

  it("R3: 401 account_login_required → invalidate + close", () => {
    const err = new ApiError(401, "Sign in", "account_login_required");
    const outcome = buildSubmitErrorOutcome(err);
    expect(outcome.shouldInvalidate).toBe(true);
    expect(outcome.shouldClose).toBe(true);
    expect(outcome.message).toBe("");
  });

  it("R4: 401 with unrelated code → inline error, do NOT close", () => {
    const err = new ApiError(401, "Account mismatch", "account_mismatch");
    const outcome = buildSubmitErrorOutcome(err);
    expect(outcome.shouldInvalidate).toBe(false);
    expect(outcome.shouldClose).toBe(false);
    expect(outcome.message).toBe("Account mismatch");
  });

  it("R5: 500 → inline error", () => {
    const err = new ApiError(500, "boom", "internal_error");
    const outcome = buildSubmitErrorOutcome(err);
    expect(outcome.shouldInvalidate).toBe(false);
    expect(outcome.shouldClose).toBe(false);
    expect(outcome.message).toBe("boom");
  });

  it("R6: 422 validation_failed → inline error", () => {
    const err = new ApiError(422, "Validation failed", "validation_failed");
    const outcome = buildSubmitErrorOutcome(err);
    expect(outcome.shouldInvalidate).toBe(false);
    expect(outcome.shouldClose).toBe(false);
    expect(outcome.message).toBe("Validation failed");
  });

  it("R7: ApiError with empty message falls back to default copy", () => {
    const err = new ApiError(500, "");
    const outcome = buildSubmitErrorOutcome(err);
    expect(outcome.message).toBe("Submission failed");
  });
});

describe("validateQuestionText — trim-aware validation", () => {
  it("V1: empty string → invalid, length 0, remaining 10", () => {
    const v = validateQuestionText("");
    expect(v.valid).toBe(false);
    expect(v.trimmedLength).toBe(0);
    expect(v.remainingForMin).toBe(10);
  });

  it("V2: 10 spaces → invalid (trimmed length 0)", () => {
    const v = validateQuestionText("          ");
    expect(v.valid).toBe(false);
    expect(v.trimmedLength).toBe(0);
    expect(v.remainingForMin).toBe(10);
  });

  it("V3: 9 chars → invalid, remainingForMin 1", () => {
    const v = validateQuestionText("a".repeat(9));
    expect(v.valid).toBe(false);
    expect(v.trimmedLength).toBe(9);
    expect(v.remainingForMin).toBe(1);
  });

  it("V4: exactly 10 chars → valid, remaining 0", () => {
    const v = validateQuestionText("a".repeat(10));
    expect(v.valid).toBe(true);
    expect(v.trimmedLength).toBe(10);
    expect(v.remainingForMin).toBe(0);
  });

  it("V5: leading + trailing whitespace counts trimmed length only", () => {
    const v = validateQuestionText("   abcdefghij   ");
    expect(v.valid).toBe(true);
    expect(v.trimmedLength).toBe(10);
    expect(v.remainingForMin).toBe(0);
  });

  it("V6: exactly 5000 chars → valid", () => {
    const v = validateQuestionText("a".repeat(5000));
    expect(v.valid).toBe(true);
    expect(v.trimmedLength).toBe(5000);
  });

  it("V7: 5001 chars → invalid (over max)", () => {
    const v = validateQuestionText("a".repeat(5001));
    expect(v.valid).toBe(false);
    expect(v.trimmedLength).toBe(5001);
    expect(v.remainingForMin).toBe(0);
  });

  it("V8: limits constant matches schema (10..5000)", () => {
    expect(QUESTION_TEXT_LIMITS.min).toBe(10);
    expect(QUESTION_TEXT_LIMITS.max).toBe(5000);
  });
});

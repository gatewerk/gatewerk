import { ApiError } from "../../api/client/http";

/**
 * Pure-state helpers extracted from RecipientActions (spec §7 E3 + E4).
 * Hosts the error-code → user-surface mapping and the trim-aware
 * question_text validator. Apps/web has no jsdom; all DOM coverage is
 * Playwright. These pure functions are unit-tested in
 * recipient-actions-state.test.ts (see share-via-link-state precedent).
 */

export interface SubmitErrorOutcome {
  /** User-facing message; empty string means swallow the error silently. */
  message: string;
  /**
   * True when the page-level token-review query should be invalidated to
   * pick up the new terminal state (already-used, otp_required, login
   * required) — these are not "errors", they are stale-validation
   * outcomes that need a fresh GET /r/:token to route the page.
   */
  shouldInvalidate: boolean;
  /** True when the open modal should close (no actionable retry surface). */
  shouldClose: boolean;
}

/**
 * Map an ApiError from decline / raise-questions to the onError surface.
 * 410 (token consumed mid-flight), 401 email_otp_required, and 401
 * account_login_required all collapse to "re-route the page" outcomes
 * with no actionable inline message; everything else surfaces as a
 * destructive inline error so the recipient can retry or back out.
 */
export function buildSubmitErrorOutcome(err: ApiError): SubmitErrorOutcome {
  if (err.status === 410) {
    return { message: "", shouldInvalidate: true, shouldClose: true };
  }
  if (err.status === 401 && err.code === "email_otp_required") {
    return { message: "", shouldInvalidate: true, shouldClose: true };
  }
  if (err.status === 401 && err.code === "account_login_required") {
    return { message: "", shouldInvalidate: true, shouldClose: true };
  }
  return {
    message: err.message || "Submission failed",
    shouldInvalidate: false,
    shouldClose: false,
  };
}

export interface QuestionValidation {
  valid: boolean;
  trimmedLength: number;
  /**
   * Characters remaining until the min-10 gate is satisfied. 0 once
   * trimmedLength >= 10. Always non-negative.
   */
  remainingForMin: number;
}

const QUESTION_TEXT_MIN = 10;
const QUESTION_TEXT_MAX = 5000;

/**
 * Validate a candidate question_text against the server schema mirror.
 * Server schema is `z.string().trim().min(10).max(5000)`; this helper
 * applies the same trim semantics so the client counter and the submit
 * gate cannot drift. The boundary (10, 5000) is shared with the server
 * — changes ripple by updating both the schema and this constant pair.
 */
export function validateQuestionText(text: string): QuestionValidation {
  const trimmed = text.trim();
  const trimmedLength = trimmed.length;
  const valid =
    trimmedLength >= QUESTION_TEXT_MIN && trimmedLength <= QUESTION_TEXT_MAX;
  const remainingForMin = Math.max(QUESTION_TEXT_MIN - trimmedLength, 0);
  return { valid, trimmedLength, remainingForMin };
}

export const QUESTION_TEXT_LIMITS = {
  min: QUESTION_TEXT_MIN,
  max: QUESTION_TEXT_MAX,
} as const;

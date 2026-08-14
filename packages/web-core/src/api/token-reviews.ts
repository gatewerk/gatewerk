import { ApiError, getToken, publicRequest } from "./client/http";
import type {
  TemplateField,
  TemplateActionConfigCanonical,
} from "@gatewerk/shared";

interface ReviewPayload {
  id: string;
  payload: Record<string, unknown>;
  priority: string;
  /**
   * Legacy string-array projection of the `reviews.actions` column. Newer
   * consumers should read `template.actions` (canonical shape) instead.
   */
  actions: string[];
  template_slug: string;
  created_at: string;
}

interface TemplateProjection {
  name: string;
  description?: string;
  fields: TemplateField[];
  /**
   * Canonical action shape projected by GET /r/:token (server applies
   * normalizeTemplateActions before serialization).
   */
  actions: TemplateActionConfigCanonical[];
}

/**
 * Discriminated union mapped from the GET /r/:token wire response. The
 * server response is already disjoint along (status, requires_email_otp,
 * requires_account_login, account_mismatch); the mapper at validateToken()
 * collapses the optional flags into six exhaustive shapes so consumer
 * render branches narrow correctly and cannot accidentally read
 * review.payload off undefined.
 *
 *   - {status:"valid", kind:"ready"}            review payload + template visible
 *   - {status:"valid", kind:"needs_otp"}        recipient must complete email-OTP
 *   - {status:"valid", kind:"needs_login"}      account-bound; recipient not signed in
 *   - {status:"valid", kind:"account_mismatch"} account-bound; wrong identity (E15)
 *   - {status:"expired"}                        token past its expires_at window
 *   - {status:"revoked"}                        link revoked by the sender
 *   - {status:"used"}                           review already decided
 */
export type TokenReviewData =
  | {
      status: "valid";
      kind: "ready";
      is_preview?: boolean;
      sender_hint?: string;
      review: ReviewPayload;
      template: TemplateProjection | null;
    }
  | {
      status: "valid";
      kind: "needs_otp";
      recipient_email_hint: string;
      sender_hint?: string;
      cookie_invalid?: boolean;
    }
  | {
      status: "valid";
      kind: "needs_login";
      sender_hint?: string;
    }
  | {
      status: "valid";
      kind: "account_mismatch";
      current_account_label: string;
      sender_hint?: string;
    }
  | { status: "expired"; message?: string; sender_hint?: string }
  | { status: "revoked"; message?: string; sender_hint?: string }
  | {
      status: "used";
      decision: string;
      decided_at?: string;
      message?: string;
    };

export interface OtpRequestResult {
  status: "sent";
}

export interface OtpVerifyResult {
  status: "verified";
}

export interface TokenDecisionResult {
  status: "decided";
  decision: string;
  decided_at: string;
  message: string;
}

export interface TokenDeclineResult {
  status: "declined";
  message: string;
}

export interface TokenRaiseQuestionsResult {
  status: "questions_raised";
  message: string;
}

export interface TokenActionResult {
  status: "decided";
  decision: string;
  decided_at: string;
  message: string;
}

/**
 * Build the headers map for recipient-flow fetches. Attaches the main-app
 * Bearer JWT when the visitor is logged in (sessionStorage / localStorage)
 * so account-bound tokens can match auth_user_id server-side. Server
 * safely ignores Authorization on public + email_otp tokens (those
 * branches do not read the header). Audience-claim isolation in the
 * server's validateJwt rejects recipient-session JWTs replayed here
 * (RFC 7519 §4.1.3); a recipient-session cookie cannot impersonate a
 * main-app session even if forwarded into Authorization.
 *
 * publicRequest is intentionally bypassed here — broadening it to
 * optionally attach Authorization would widen the auth-attach blast
 * radius across every public endpoint (invite, OTP request / verify)
 * when only the recipient flow needs the conditional Bearer.
 */
function recipientHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const sessionToken = getToken();
  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
  }
  return headers;
}

/**
 * Validate a review link token. The wire response is loose-typed (optional
 * flags); this mapper collapses to the discriminated union so consumers
 * narrow on (status, kind) exhaustively. 410 Gone is mapped to terminal
 * states so the page renders the correct final-state UI instead of throwing.
 */
export async function validateToken(token: string): Promise<TokenReviewData> {
  const res = await fetch(`/api/v1/r/${token}`, {
    headers: recipientHeaders(),
    credentials: "include",
  });
  // Read the body as text first so JSON.parse failures surface as ApiError
  // instead of the raw SyntaxError. RFC 7159 — malformed JSON on a 200
  // response is a server protocol violation; mapping it to ApiError lets
  // consumers route to a diagnostic state instead of crashing on
  // undefined.review.payload deeper in the render tree.
  const text = await res.text();
  let body: any = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, "Server returned malformed response");
    }
  }
  if (body === null || typeof body !== "object") {
    // Null or non-object 200 (e.g. server stringified a primitive or
    // returned `null`) — surface as ApiError so consumers do not crash
    // on `body.requires_email_otp` later. Only objects are a valid
    // wire shape per the GET /r/:token contract.
    throw new ApiError(res.status, "Server returned a non-object response");
  }

  // Mutual-exclusion guard for the auth-tier flags. requires_email_otp,
  // requires_account_login, and account_mismatch are disjoint server-side
  // (one branch fires per GET /r/:token). Multiple flags set on the same
  // response is a server protocol violation; surface as ApiError so the
  // consumer routes to a diagnostic state instead of silently picking the
  // first-match-wins branch and rendering wrong UI.
  const flags = [
    body.requires_email_otp === true,
    body.requires_account_login === true,
    body.account_mismatch === true,
  ];
  if (flags.filter(Boolean).length > 1) {
    throw new ApiError(res.status, "Server returned conflicting auth-tier flags");
  }

  if (res.status === 410) {
    if (body.status === "used") {
      return {
        status: "used",
        decision: body.decision ?? "unknown",
        decided_at: body.decided_at,
        message: body.message,
      };
    }
    // The server distinguishes a revoked link from an expired one
    // (token-reviews.ts GET branch); keep them apart so the recipient page can
    // say "invalid / may have been revoked" instead of "expired".
    if (body.status === "revoked") {
      return {
        status: "revoked",
        message: body.message,
        sender_hint: typeof body.sender_hint === "string" ? body.sender_hint : undefined,
      };
    }
    return {
      status: "expired",
      message: body.message,
      sender_hint: typeof body.sender_hint === "string" ? body.sender_hint : undefined,
    };
  }

  if (!res.ok) {
    throw new ApiError(
      res.status,
      body.error?.message || body.message || res.statusText,
      body.error?.code,
    );
  }

  // 200 OK — branch on the wire's loose flag. requires_email_otp:true means
  // the server omitted review/template (auth_level=email_otp gate); surface
  // as kind:"needs_otp" so consumers cannot read review.payload off undefined.
  if (body.requires_email_otp === true) {
    return {
      status: "valid",
      kind: "needs_otp",
      recipient_email_hint: body.recipient_email_hint ?? "",
      sender_hint: typeof body.sender_hint === "string" ? body.sender_hint : undefined,
      cookie_invalid: body.cookie_invalid === true ? true : undefined,
    };
  }

  // Account-bound recipient flow (token redesign §6.2). requires_account_login
  // → recipient must complete /login with a return_to back to /r/:token.
  // account_mismatch (E15) → recipient is logged in as the wrong user.
  if (body.requires_account_login === true) {
    return {
      status: "valid",
      kind: "needs_login",
      sender_hint: typeof body.sender_hint === "string" ? body.sender_hint : undefined,
    };
  }
  if (body.account_mismatch === true) {
    return {
      status: "valid",
      kind: "account_mismatch",
      current_account_label:
        typeof body.current_account_label === "string"
          ? body.current_account_label
          : "your account",
      sender_hint: typeof body.sender_hint === "string" ? body.sender_hint : undefined,
    };
  }

  return {
    status: "valid",
    kind: "ready",
    is_preview: body.is_preview === true,
    sender_hint: typeof body.sender_hint === "string" ? body.sender_hint : undefined,
    review: body.review,
    template: body.template ?? null,
  };
}

/**
 * Submit a decision via the recipient flow. Shares recipientHeaders()
 * so account-bound tokens can satisfy the server-side identity check.
 */
export async function decideViaToken(
  token: string,
  data: { decision: string; feedback?: string; edited_payload?: Record<string, unknown> },
): Promise<TokenDecisionResult> {
  const res = await fetch(`/api/v1/r/${token}/decide`, {
    method: "POST",
    headers: recipientHeaders(),
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      body.error?.message || body.message || res.statusText,
      body.error?.code,
    );
  }
  if (res.status === 204) return undefined as unknown as TokenDecisionResult;
  return res.json();
}

/**
 * Request a new 6-digit verification code for the recipient bound to
 * this token. The server matches the submitted email against the
 * token's pinned auth_email (case-insensitive) and refuses if it does
 * not match or if a code has already been sent within the 60s
 * resend cooldown.
 */
export async function requestOtp(
  token: string,
  email: string,
): Promise<OtpRequestResult> {
  return publicRequest<OtpRequestResult>(`/api/v1/r/${token}/email-otp/request`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

/**
 * Submit a 6-digit code. On success the server sets a recipient session
 * cookie scoped to /api/v1/r so subsequent GET /api/v1/r/:token and
 * POST /api/v1/r/:token/decide calls succeed (RFC 6265 §5.3 path-match).
 */
export async function verifyOtp(
  token: string,
  code: string,
): Promise<OtpVerifyResult> {
  return publicRequest<OtpVerifyResult>(`/api/v1/r/${token}/email-otp/verify`, {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

/**
 * Decline the review via token (spec §7 E3). Reverts the review to
 * pending; the token is consumed and a decline note is created on the
 * review. decision stays NULL — this is not a decision.
 */
export async function declineViaToken(
  token: string,
  data: { decline_reason?: string },
): Promise<TokenDeclineResult> {
  const res = await fetch(`/api/v1/r/${token}/decline`, {
    method: "POST",
    headers: recipientHeaders(),
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      body.error?.message || body.message || res.statusText,
      body.error?.code,
    );
  }
  return res.json();
}

/**
 * Send the review back to the reviewer with questions (spec §7 E4).
 * Reverts the review to pending; the token is consumed and a question
 * note is attached. question_text is REQUIRED, 10-5000 chars; the server
 * mirrors this validation independently of any client-side gating.
 */
export async function raiseQuestionsViaToken(
  token: string,
  data: { question_text: string },
): Promise<TokenRaiseQuestionsResult> {
  const res = await fetch(`/api/v1/r/${token}/raise-questions`, {
    method: "POST",
    headers: recipientHeaders(),
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      body.error?.message || body.message || res.statusText,
      body.error?.code,
    );
  }
  return res.json();
}

/**
 * Submit an action via the recipient flow using the canonical
 * /r/:token/action endpoint (Phase 7). Dispatches decision-kind actions
 * by action_id; the server resolves the decision_value and records the
 * decision. Shares recipientHeaders() so account-bound tokens can satisfy
 * the server-side identity check.
 */
export async function actionViaToken(
  token: string,
  data: { action_id: string; feedback?: string; edited_payload?: Record<string, unknown>; version?: number },
): Promise<TokenActionResult> {
  const res = await fetch(`/api/v1/r/${token}/action`, {
    method: "POST",
    headers: recipientHeaders(),
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      body.error?.message || body.message || res.statusText,
      body.error?.code,
    );
  }
  return res.json();
}

export const tokenReviews = {
  validate: validateToken,
  decide: decideViaToken,
  action: actionViaToken,
  decline: declineViaToken,
  raiseQuestions: raiseQuestionsViaToken,
  requestOtp,
  verifyOtp,
};

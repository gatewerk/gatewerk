import { hmacSha256Base64url, constantTimeEqual } from "./crypto";
import { config } from "../config";

interface TokenPayload {
  reviewer_id: string;
  email: string;
  purpose: "verify-email" | "reset-password" | "digest_unsubscribe" | "slack_oauth_state";
  exp: number;
  /** Present only when purpose is slack_oauth_state. Null in OSS (single-org). */
  organization_id?: string | null;
}

// Email-link tokens use config.hmacSecret rather than config.jwtSecret so
// that rotating session-signing material does not invalidate outstanding
// password-reset / email-verify links, and vice versa.
export function generateEmailToken(payload: Omit<TokenPayload, "exp">, ttlMs: number): string {
  const exp = Date.now() + ttlMs;
  const data: TokenPayload = { ...payload, exp };
  const json = JSON.stringify(data);
  const encoded = Buffer.from(json).toString("base64url");
  const signature = hmacSha256Base64url(config.hmacSecret, encoded);
  return `${encoded}.${signature}`;
}

export function verifyEmailToken(
  token: string,
  expectedPurpose: TokenPayload["purpose"],
): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts;
  const expectedSig = hmacSha256Base64url(config.hmacSecret, encoded);

  if (!constantTimeEqual(signature, expectedSig)) {
    return null;
  }

  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const payload: TokenPayload = JSON.parse(json);

    if (payload.purpose !== expectedPurpose) return null;
    if (payload.exp < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

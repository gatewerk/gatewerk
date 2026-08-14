import jwt from "jsonwebtoken";
import { config } from "../../config";
import { serverEnv } from "../../env";

/**
 * Token-recipient session module.
 *
 * Issues + verifies short-lived JWT cookies that grant a recipient
 * permission to decide on a single review token after passing email-OTP
 * verification.
 *
 * Key invariants:
 *   - audience claim = "token-recipient" — distinguishes from main-app
 *     reviewer sessions (legacy unaudienced) so a leaked cookie value
 *     pasted into the Authorization header cannot pass user auth, and
 *     vice versa. validateJwt in lib/auth-helpers explicitly rejects
 *     this audience at the main-app gate (defense-in-depth).
 *   - subject claim = token_id — binds the cookie to ONE token; the
 *     cookie cannot be replayed against a different /r/:token URL.
 *   - HS256 algorithm pinned on both sign and verify per RFC 7518 §3.2
 *     — eliminates algorithm-confusion surface (alg: none, RS256/HS
 *     symmetric-vs-asymmetric flips).
 *   - 30 minute absolute lifetime via exp claim; cookie Max-Age mirrors.
 *
 * Cookie attributes set by the route handler (not this module):
 *   - Name:      __Secure-gatewerk_token_session (NODE_ENV=production)
 *                gatewerk_token_session         (dev / test)
 *   - HttpOnly:  true   (XSS cookie theft mitigation)
 *   - Secure:    true   (production only — RFC 6265bis §4.1.3
 *                       __Secure- prefix requires the Secure attribute)
 *   - SameSite:  Strict (the cookie is only consumed by AJAX requests
 *                       fired from the same-origin SPA after OTP verify;
 *                       the initial email link arrives BEFORE any cookie
 *                       exists so SameSite has no effect on the landing
 *                       navigation. Strict maximizes CSRF resistance for
 *                       the decide/action/decline endpoints.)
 *   - Path:      /api/v1/r  (scoped to recipient API endpoints; the Express
 *                            router is also mounted at /r for direct dev
 *                            access on the API container, but production
 *                            traffic always goes through the nginx proxy at
 *                            /api/v1/r — cookies will not ship to direct
 *                            /r/* hits which is intentional dev-only
 *                            behavior. RFC 6265 §5.1.4 path-match rule 3
 *                            means /api/v1/runs (any future sibling) would
 *                            NOT receive this cookie because the next char
 *                            after the prefix must be `/`.)
 *   - Max-Age:   1800   (mirrors JWT exp — defense in depth)
 */

export const RECIPIENT_SESSION_AUDIENCE = "token-recipient";
export const RECIPIENT_SESSION_ISSUER = "gatewerk";
export const RECIPIENT_SESSION_TTL_SECONDS = 30 * 60;

export const RECIPIENT_SESSION_COOKIE_NAME =
  serverEnv.NODE_ENV === "production"
    ? "__Secure-gatewerk_token_session"
    : "gatewerk_token_session";

/**
 * Per-token cookie name.
 *
 * The session JWT's subject is a single token_id, so one shared cookie name
 * means a recipient who opens a second review link silently evicts the first
 * link's session: returning to it reports "your previous session expired"
 * when nothing expired. Suffixing the name with the token row id (an opaque
 * short id, never the URL secret) keeps concurrent links independent.
 */
export function recipientSessionCookieName(tokenId: string): string {
  return `${RECIPIENT_SESSION_COOKIE_NAME}_${tokenId}`;
}

export interface RecipientSessionPayload {
  /** subject — bound to this single token_id */
  sub: string;
  /** verified email of the recipient at the time of OTP verification */
  email: string;
}

export function signRecipientSession(payload: RecipientSessionPayload): string {
  return jwt.sign({ email: payload.email }, config.jwtSecret, {
    algorithm: "HS256",
    audience: RECIPIENT_SESSION_AUDIENCE,
    issuer: RECIPIENT_SESSION_ISSUER,
    expiresIn: RECIPIENT_SESSION_TTL_SECONDS,
    subject: payload.sub,
  });
}

/**
 * Verifies a recipient session cookie and asserts subject == expectedTokenId.
 * Returns the decoded payload on success; null on any verification failure
 * (expired, wrong audience, wrong issuer, wrong subject, bad signature).
 *
 * Never throws — verification errors flow through as null so route handlers
 * branch on a single shape.
 */
export function verifyRecipientSession(
  cookieValue: string,
  expectedTokenId: string,
): RecipientSessionPayload | null {
  try {
    const decoded = jwt.verify(cookieValue, config.jwtSecret, {
      algorithms: ["HS256"],
      audience: RECIPIENT_SESSION_AUDIENCE,
      issuer: RECIPIENT_SESSION_ISSUER,
      subject: expectedTokenId,
    }) as { sub: string; email: string; aud: string; iss: string };
    return { sub: decoded.sub, email: decoded.email };
  } catch {
    return null;
  }
}

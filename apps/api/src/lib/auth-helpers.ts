import { eq, and, isNull, gt } from "drizzle-orm";
import { createHash } from "crypto";
import { BlockList, isIP } from "net";
import jwt from "jsonwebtoken";
import { apiKeys, reviewers, sessions } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import { config } from "../config";
import { serverEnv } from "../env";

export interface ApiKeyResult {
  projectId: string;
  apiKeyId: string;
  apiKeyPrefix: string;
  scopes: string[];
  templateIds: string[] | null;
  callbackUrl: string | null;
  defaultReviewer: string | null;
  rateLimitPerHour: number | null;
  expiresAt: Date | null;
  ipAllowlist: string[] | null;
}

export type CidrValidation =
  | { ok: true; family: 4 | 6; prefix: number | null }
  | { ok: false; reason: string };

/**
 * Parse a single entry from an IP allowlist. Supports plain IPv4/IPv6
 * addresses and CIDR blocks ("10.0.0.0/8", "2001:db8::/32").
 */
export function parseIpOrCidr(entry: string): CidrValidation {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };

  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    const family = isIP(trimmed);
    if (family === 0) return { ok: false, reason: "not-an-ip" };
    return { ok: true, family: family as 4 | 6, prefix: null };
  }

  const addr = trimmed.slice(0, slash);
  const prefixRaw = trimmed.slice(slash + 1);
  const family = isIP(addr);
  if (family === 0) return { ok: false, reason: "not-an-ip" };
  if (!/^\d+$/.test(prefixRaw)) return { ok: false, reason: "non-numeric-prefix" };
  const prefix = Number(prefixRaw);
  const max = family === 4 ? 32 : 128;
  if (prefix < 0 || prefix > max) return { ok: false, reason: `prefix-out-of-range:0-${max}` };
  return { ok: true, family: family as 4 | 6, prefix };
}

/**
 * Normalize an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`) to plain IPv4.
 * Node's dual-stack sockets expose connecting clients this way even for pure
 * IPv4 traffic, and BlockList treats the two as incompatible families.
 */
function normalizeClientIp(ip: string): string {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const tail = ip.slice(7);
    if (isIP(tail) === 4) return tail;
  }
  return ip;
}

/**
 * True if `ip` matches any entry in `allowlist`. Exact IP entries match via
 * node:net BlockList with a /32 or /128 subnet; CIDR entries match via their
 * declared prefix length.
 *
 * F6 fail-closed invariant (regression-locked in `ip-allowlist-fail-closed.test.ts`):
 * malformed entries are silently skipped rather than thrown, because the route
 * layer at `routes/api-keys/crud.ts` is contractually responsible for rejecting
 * bad input at write time ("loud at init"). If a malformed entry ever reaches
 * runtime (DB drift, direct edit, corrupted backup), the BlockList is populated
 * only from the *valid* entries — a reduced BlockList still returns false for
 * every query that no valid entry matches. This is the fail-closed property: a
 * silent skip never flips to "allow all," because `BlockList.check()` on an
 * empty or reduced list rejects by default. Future refactors that change this
 * semantic (e.g., "empty allowlist = allow all") must also update F6 tests.
 */
export function ipMatchesAllowlist(ip: string, allowlist: string[]): boolean {
  const normalized = normalizeClientIp(ip);
  const ipFamily = isIP(normalized);
  if (ipFamily === 0) return false;

  const list = new BlockList();
  for (const entry of allowlist) {
    const parsed = parseIpOrCidr(entry);
    if (!parsed.ok) continue; // malformed — by contract rejected at the write-path; skipping here keeps fail-closed.
    const family = parsed.family === 4 ? "ipv4" : "ipv6";
    const slash = entry.indexOf("/");
    if (slash === -1) {
      list.addAddress(entry.trim(), family);
    } else {
      list.addSubnet(entry.slice(0, slash).trim(), parsed.prefix!, family);
    }
  }
  return list.check(normalized, ipFamily === 4 ? "ipv4" : "ipv6");
}

export interface SessionResult {
  id: string;
  email: string;
  name: string;
  role: string;
  sessionId?: string;
  jti?: string;
  lastActiveAt?: Date;
}

export async function validateApiKey(token: string, db: AppDb): Promise<ApiKeyResult | null> {
  const keyHash = createHash("sha256").update(token).digest("hex");

  const [found] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.key_hash, keyHash), eq(apiKeys.is_active, true)))
    .limit(1);

  if (!found) return null;

  // Fire-and-forget last_used_at update
  db.update(apiKeys)
    .set({ last_used_at: new Date() })
    .where(eq(apiKeys.id, found.id))
    .catch(() => {});

  return {
    projectId: found.project_id,
    apiKeyId: found.id,
    apiKeyPrefix: found.key_prefix,
    scopes: found.scopes as string[],
    templateIds: (found.template_ids as string[] | null) ?? null,
    callbackUrl: (found.callback_url as string | null) ?? null,
    defaultReviewer: (found.default_reviewer as string | null) ?? null,
    rateLimitPerHour: (found.rate_limit_per_hour as number | null) ?? null,
    expiresAt: (found.expires_at as Date | null) ?? null,
    ipAllowlist: (found.ip_allowlist as string[] | null) ?? null,
  };
}

export async function validateJwt(token: string, db: AppDb): Promise<SessionResult | null> {
  // Pinning the allowed algorithm prevents the verifier from inferring it
  // from the token's JOSE header. jsonwebtoken@9 rejects `alg: "none"` by
  // default, but an un-pinned verify will still accept any HMAC family
  // (HS256/384/512) — or, if `config.jwtSecret` ever got loaded as a PEM
  // public key, asymmetric algorithms. Sign-side at routes/auth.ts uses the
  // default HS256, so HS256-only matches the issued-token invariant.
  const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"], audience: "gatewerk-dashboard", issuer: "gatewerk-api" }) as {
    sub: string;
    email: string;
    tokenVersion?: number;
    aud?: string;
    jti?: string;
  };

  // Defense-in-depth: reject any cookie value that was signed for the
  // recipient flow if it has been replayed into the Authorization: Bearer
  // header. Recipient tokens carry audience "token-recipient" (see
  // services/token-recipient-session); legacy main-app sessions are
  // unaudienced. Negative-match — adding a positive `audience: "user"`
  // constraint would invalidate every existing reviewer's session at
  // verify time. Migrating main-app signing to carry an explicit audience
  // is a v1.5 backlog item; once shipped this flips to a positive match.
  if (payload.aud === "token-recipient") {
    return null;
  }

  // Session-backed validation (post-Wave-1 tokens with jti claim)
  if (payload.jti) {
    const [row] = await db
      .select({
        id: reviewers.id,
        email: reviewers.email,
        name: reviewers.name,
        role: reviewers.role,
        is_active: reviewers.is_active,
        token_version: reviewers.token_version,
        sessionId: sessions.id,
        lastActiveAt: sessions.last_active_at,
      })
      .from(reviewers)
      .innerJoin(sessions, and(
        eq(sessions.reviewer_id, reviewers.id),
        eq(sessions.jti, payload.jti),
        isNull(sessions.revoked_at),
        gt(sessions.expires_at, new Date()),
      ))
      .where(eq(reviewers.id, payload.sub))
      .limit(1);

    if (!row || !row.is_active) return null;

    const dbTokenVersion = row.token_version ?? 0;
    const jwtTokenVersion = payload.tokenVersion ?? 0;
    if (dbTokenVersion !== jwtTokenVersion) return null;

    // Inactivity timeout check
    const inactivityMs = serverEnv.SESSION_INACTIVITY_TIMEOUT_HOURS * 60 * 60 * 1000;
    if (row.lastActiveAt && Date.now() - row.lastActiveAt.getTime() > inactivityMs) {
      return null;
    }

    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      sessionId: row.sessionId,
      jti: payload.jti,
      lastActiveAt: row.lastActiveAt ?? undefined,
    };
  }

  // Legacy path: no jti claim — validate via token_version only
  // (backward compatibility for pre-Wave-1 tokens during rollout)
  const [reviewer] = await db
    .select()
    .from(reviewers)
    .where(eq(reviewers.id, payload.sub))
    .limit(1);

  if (!reviewer || !reviewer.is_active) return null;

  const dbTokenVersion = reviewer.token_version ?? 0;
  const jwtTokenVersion = payload.tokenVersion ?? 0;
  if (dbTokenVersion !== jwtTokenVersion) return null;

  return {
    id: reviewer.id,
    email: reviewer.email,
    name: reviewer.name,
    role: reviewer.role,
  };
}

/**
 * Read the main-app session JWT off the Authorization: Bearer header,
 * returning a `SessionResult` for a valid session or `null` for any
 * failure (missing header, malformed token, expired, signature mismatch,
 * audience-claim rejection per RFC 7519 §4.1.3, deactivated user,
 * stale token_version). Never throws — callers route on null.
 *
 * Used by recipient-flow handlers that consume the main-app session for
 * account-bound tokens (`auth_level: "account"`). Identity check vs the
 * token's `auth_user_id` happens at the call site, not here. The audience
 * negative-match in `validateJwt` already rejects recipient-session JWTs
 * (issued with `aud: "token-recipient"`) so a cookie value forwarded into
 * the Authorization header cannot impersonate a main-app session.
 */
export async function tryReadMainAppSession(
  req: { headers: { authorization?: string } },
  db: AppDb,
): Promise<SessionResult | null> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  if (token.length === 0) return null;
  try {
    return await validateJwt(token, db);
  } catch {
    return null;
  }
}

// Per-tab session cache for review-token URLs. Tokens themselves return only
// once from the API (the token JWT is hashed at rest); the freshly minted URL
// is held here so the right pane can re-show "Copy" after the share dialog
// closes within the same tab session. Cleared at logout (use-auth.tsx) so
// per-user JWT scope is preserved. sessionStorage matches the gatewerk_token
// JWT pattern in api/client/http.ts.

const KEY_PREFIX = "gatewerk_token_link_";

function safeSession(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function cacheTokenLink(reviewId: string, url: string): void {
  const s = safeSession();
  if (!s) return;
  try {
    s.setItem(KEY_PREFIX + reviewId, url);
  } catch {
    // Quota exceeded or private-browsing storage error — silent fail.
  }
}

export function readCachedTokenLink(reviewId: string): string | null {
  const s = safeSession();
  if (!s) return null;
  try {
    return s.getItem(KEY_PREFIX + reviewId);
  } catch {
    return null;
  }
}

export function clearCachedTokenLink(reviewId: string): void {
  const s = safeSession();
  if (!s) return;
  try {
    s.removeItem(KEY_PREFIX + reviewId);
  } catch {
    // Silent — best-effort cleanup.
  }
}

export function clearAllCachedTokenLinks(): void {
  const s = safeSession();
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(KEY_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => s.removeItem(k));
  } catch {
    // Silent.
  }
}

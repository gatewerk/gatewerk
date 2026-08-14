/**
 * safe-url.ts — scheme allowlist for payload values that reach an `href` / `src`.
 *
 * Review payload content is authored by the calling agent, and a template can
 * declare a field as `type:"url"`, so an unchecked value puts attacker-chosen
 * text into a link. `javascript:` there is XSS on both the recipient page
 * (public, unauthenticated) and the inbox (session + API access).
 *
 * Pure — no React, no DOM beyond the URL parser. Tested in safe-url.test.ts.
 */

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const MEDIA_SCHEMES = new Set(["http:", "https:"]);

/**
 * Returns the normalized URL when `value` is an absolute URL on an allowed
 * scheme, else null. Callers render the raw value as plain text on null.
 * `kind:"media"` drops mailto (an <img src="mailto:…"> is never intended).
 */
export function safeUrl(value: unknown, kind: "link" | "media"): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const allowed = kind === "link" ? LINK_SCHEMES : MEDIA_SCHEMES;
  try {
    const parsed = new URL(value);
    return allowed.has(parsed.protocol) ? parsed.toString() : null;
  } catch {
    // Relative or malformed: not something we will link to.
    return null;
  }
}

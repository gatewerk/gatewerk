const DENIED_OUTBOUND_HEADERS = new Set([
  "host", "content-length", "transfer-encoding", "connection",
  "keep-alive", "te", "trailer", "upgrade",
]);

/**
 * Filter admin-supplied custom headers before merging into an outbound webhook
 * request. Drops hop-by-hop and smuggling-prone headers (Host, Content-Length,
 * Transfer-Encoding, Connection, etc.) that should never be overridden from
 * config. undici sanitises most of these client-side already; the deny-list is
 * defence-in-depth and keeps the audit trail clean.
 */
export function scrubOutboundHeaders(input: Record<string, string> | null | undefined): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (DENIED_OUTBOUND_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

export const PREVIEW_MAX_BYTES = 1024; // generous enough for HTTP error bodies, tight enough to not amplify a response-oracle attack

/**
 * Truncate a response body preview so we surface enough of an HTTP error body
 * for an admin to diagnose, without unbounded amplification of an authenticated
 * SSRF response oracle. Byte-length cap (not UTF-16 code-unit cap) so multi-byte
 * characters at the boundary do not produce a lone surrogate that breaks JSON
 * serialization downstream.
 */
export function truncatePreview(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= PREVIEW_MAX_BYTES) return text;
  // Trim by byte then validate via TextDecoder fatal=false to drop any
  // partial trailing multi-byte sequence cleanly.
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  const slice = buf.subarray(0, PREVIEW_MAX_BYTES);
  const decoded = decoder.decode(slice);
  return `${decoded}…`;
}

import dns from "node:dns";
import { isIP } from "net";
import { InvalidRequestError } from "@gatewerk/shared";
import { serverEnv } from "../env";

const PRIVATE_HOSTNAMES = new Set(["localhost", "localhost."]);

const PRIVATE_IP_RANGES = [
  /^127\./,                          // 127.0.0.0/8 loopback
  /^10\./,                           // 10.0.0.0/8 private
  /^172\.(1[6-9]|2[0-9]|3[01])\./,  // 172.16.0.0/12 private
  /^192\.168\./,                     // 192.168.0.0/16 private
  /^0\./,                            // 0.0.0.0/8
  /^169\.254\./,                     // link-local
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
];

// IPv6 private-range regexes run only after `isIP(bare) === 6` — see
// isPrivateHost() — so they can be loose on the "is this IPv6" axis but
// must be tight enough not to over-match within the IPv6 space.
//
// The fc/fd patterns previously matched ANY string starting with those
// two letters (including DNS hostnames like `fc.com`, flagged as L-1 by
// `/launch-audit`). The structural `isIP()` gate is the real fix; the
// trailing `[0-9a-f]{0,2}:` suffix is defense-in-depth against a future
// refactor that accidentally removes the gate.
const PRIVATE_IPV6 = [
  /^::$/,                  // unspecified (all zeros)
  /^::1$/,                 // loopback
  /^fe80:/i,               // link-local (fe80::/10, Node canonicalizes to fe80:)
  /^fc[0-9a-f]{0,2}:/i,    // ULA (fc00::/7, fc00-fcff first group)
  /^fd[0-9a-f]{0,2}:/i,    // ULA (fc00::/7, fd00-fdff first group)
];

// IPv6 forms that tunnel an IPv4 address in the trailing 32 bits. Node's URL
// parser normalizes http://[::ffff:127.0.0.1]/ to hostname "[::ffff:7f00:1]"
// (hex-packed), so a string-regex against the ":: ffff:" prefix alone is not
// enough — we have to decompose the two trailing 16-bit groups back into
// dotted-quad form and re-check against PRIVATE_IP_RANGES. Without this
// decomposition, http://[::ffff:127.0.0.1]/, http://[::ffff:169.254.169.254]/,
// http://[::ffff:10.0.0.1]/, and similar NAT64 mappings silently bypass the
// guard.
const IPV4_IN_IPV6_PREFIXES: RegExp[] = [
  /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i,   // RFC 4291 IPv4-mapped IPv6
  /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i, // RFC 6052 NAT64 well-known prefix
];

function extractTunneledIpv4(bare: string): string | null {
  for (const rx of IPV4_IN_IPV6_PREFIXES) {
    const m = bare.match(rx);
    if (m) {
      const hi = parseInt(m[1], 16);
      const lo = parseInt(m[2], 16);
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return null;
}

function isPrivateHost(hostname: string): boolean {
  if (PRIVATE_HOSTNAMES.has(hostname.toLowerCase())) return true;

  // Strip IPv6 brackets before classifying; isIP() wants bare literals.
  const bare = hostname.replace(/^\[/, "").replace(/\]$/, "");
  const kind = isIP(bare);

  if (kind === 4) {
    for (const range of PRIVATE_IP_RANGES) {
      if (range.test(bare)) return true;
    }
    return false;
  }

  if (kind === 6) {
    // Decompose IPv4-in-IPv6 tunnels before IPv6-prefix checks so a mapped
    // private IPv4 is caught by PRIVATE_IP_RANGES rather than falling through.
    const tunneled = extractTunneledIpv4(bare);
    if (tunneled) {
      for (const range of PRIVATE_IP_RANGES) {
        if (range.test(tunneled)) return true;
      }
    }

    for (const range of PRIVATE_IPV6) {
      if (range.test(bare)) return true;
    }
    return false;
  }

  // DNS hostname (kind === 0) — no IP literal. DNS-form SSRF (a public DNS
  // name that resolves to a private IP, and DNS rebinding between validate
  // and connect) is NOT handled here; it's deferred to B2 (launch-readiness
  // audit §3 S2 DNS-form sub-class). Closing it requires DNS resolve +
  // IP-check at validate time and socket-level re-check against rebinding —
  // architecturally bigger than a regex refactor, so it ships as its own
  // PR (likely via `ssrf-req-filter`).
  return false;
}

export function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidRequestError("Invalid URL", "url", "invalid_url");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidRequestError(
      "Webhook URL must use http or https protocol",
      "url",
      "invalid_url_scheme",
    );
  }

  if (isPrivateHost(parsed.hostname)) {
    throw new InvalidRequestError(
      "Webhook URL must not point to private or reserved addresses",
      "url",
      "invalid_url_private_address",
    );
  }
}

export async function validateWebhookUrlWithDns(url: string): Promise<void> {
  validateWebhookUrl(url);

  // Allow test environments to skip real DNS resolution (mirrors SKIP_HIBP
  // pattern in vitest.config.ts). Never set this in production.
  if (serverEnv.SKIP_DNS_SSRF === "true") return;

  const { hostname } = new URL(url);
  const bare = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isIP(bare)) return;

  const [ipv4s, ipv6s] = await Promise.allSettled([
    dns.promises.resolve4(hostname),
    dns.promises.resolve6(hostname),
  ]);

  const allIps = [
    ...(ipv4s.status === "fulfilled" ? ipv4s.value : []),
    ...(ipv6s.status === "fulfilled" ? ipv6s.value : []),
  ];

  if (allIps.length === 0) {
    throw new InvalidRequestError(
      "Webhook URL hostname could not be resolved",
      "url",
      "unresolvable_host",
    );
  }

  for (const ip of allIps) {
    if (isPrivateHost(ip)) {
      throw new InvalidRequestError(
        "Webhook URL must not resolve to a private IP address",
        "url",
        "private_ip_resolved",
      );
    }
  }
}

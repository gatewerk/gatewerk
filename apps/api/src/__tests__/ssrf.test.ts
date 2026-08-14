import { describe, it, expect } from "vitest";
import { validateWebhookUrl } from "../lib/ssrf";

describe("SSRF Protection", () => {
  it("allows valid HTTPS URLs", () => {
    expect(() => validateWebhookUrl("https://example.com/webhook")).not.toThrow();
    expect(() => validateWebhookUrl("https://api.myapp.com/callback")).not.toThrow();
  });

  it("allows HTTP URLs (agents may use internal endpoints)", () => {
    expect(() => validateWebhookUrl("http://example.com/webhook")).not.toThrow();
  });

  it("rejects non-HTTP(S) protocols", () => {
    expect(() => validateWebhookUrl("ftp://example.com")).toThrow("must use http or https");
    expect(() => validateWebhookUrl("file:///etc/passwd")).toThrow("must use http or https");
  });

  it("rejects private IPv4 addresses", () => {
    expect(() => validateWebhookUrl("http://127.0.0.1/webhook")).toThrow("private or reserved");
    expect(() => validateWebhookUrl("http://10.0.0.1/webhook")).toThrow("private or reserved");
    expect(() => validateWebhookUrl("http://172.16.0.1/webhook")).toThrow("private or reserved");
    expect(() => validateWebhookUrl("http://192.168.1.1/webhook")).toThrow("private or reserved");
    expect(() => validateWebhookUrl("http://0.0.0.0/webhook")).toThrow("private or reserved");
  });

  it("rejects localhost variants", () => {
    expect(() => validateWebhookUrl("http://localhost/webhook")).toThrow("private or reserved");
    expect(() => validateWebhookUrl("http://localhost:3000/webhook")).toThrow("private or reserved");
  });

  it("rejects empty or invalid URLs", () => {
    expect(() => validateWebhookUrl("")).toThrow("Invalid URL");
    expect(() => validateWebhookUrl("not-a-url")).toThrow("Invalid URL");
  });

  it("rejects IPv6 loopback", () => {
    expect(() => validateWebhookUrl("http://[::1]/webhook")).toThrow("private or reserved");
  });

  // Regressions for the ssrf-regex-bypasses class (launch-readiness Phase 1
  // audit §3 S2 sibling). Node's URL parser normalizes IPv4-mapped IPv6 to
  // hex-packed form (http://[::ffff:127.0.0.1]/ → hostname "[::ffff:7f00:1]"),
  // so the string-regex guard on its own does not catch these.
  it("rejects IPv6 unspecified (::)", () => {
    expect(() => validateWebhookUrl("http://[::]/x")).toThrow("private or reserved");
  });

  it("rejects IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
    expect(() => validateWebhookUrl("http://[::ffff:127.0.0.1]/x")).toThrow("private or reserved");
  });

  it("rejects IPv4-mapped IPv6 to cloud metadata service", () => {
    expect(() => validateWebhookUrl("http://[::ffff:169.254.169.254]/x")).toThrow("private or reserved");
  });

  it("rejects IPv4-mapped IPv6 to RFC1918 ranges", () => {
    expect(() => validateWebhookUrl("http://[::ffff:10.0.0.1]/x")).toThrow("private or reserved");
    expect(() => validateWebhookUrl("http://[::ffff:172.16.0.1]/x")).toThrow("private or reserved");
    expect(() => validateWebhookUrl("http://[::ffff:192.168.1.1]/x")).toThrow("private or reserved");
  });

  it("rejects IPv4-mapped IPv6 to 0.0.0.0 and CGNAT", () => {
    expect(() => validateWebhookUrl("http://[::ffff:0.0.0.0]/x")).toThrow("private or reserved");
    expect(() => validateWebhookUrl("http://[::ffff:100.64.0.1]/x")).toThrow("private or reserved");
  });

  it("rejects verbose IPv4-mapped IPv6 notation (pre-normalization)", () => {
    // Node normalizes 0:0:0:0:0:ffff:7f00:1 to ::ffff:7f00:1 — same
    // resolved address, different input syntax.
    expect(() => validateWebhookUrl("http://[0:0:0:0:0:ffff:7f00:1]/x")).toThrow("private or reserved");
  });

  it("rejects NAT64 well-known prefix (64:ff9b::) to private IPv4", () => {
    expect(() => validateWebhookUrl("http://[64:ff9b::10.0.0.1]/x")).toThrow("private or reserved");
    expect(() => validateWebhookUrl("http://[64:ff9b::127.0.0.1]/x")).toThrow("private or reserved");
  });

  it("allows IPv4-mapped IPv6 to public IPv4 (positive case)", () => {
    // Sanity check the decomposition doesn't over-block: ::ffff:8.8.8.8
    // normalizes to ::ffff:808:808, which decomposes to 8.8.8.8 (public).
    expect(() => validateWebhookUrl("http://[::ffff:8.8.8.8]/x")).not.toThrow();
  });

  // Regressions for L-1 (launch-audit flag against session 1, pre-existing
  // bug): the `/^fc/i` and `/^fd/i` patterns in PRIVATE_IPV6 matched ANY
  // string starting with those two letters, over-blocking legitimate public
  // DNS hostnames like `fc.com` and `fd-webhooks.io`. The structural
  // `isIP()` gate added in B1 fixes this by running the IPv6 regexes only
  // when the hostname is actually an IPv6 literal. The tightened regex
  // suffixes (`[0-9a-f]{0,2}:`) are defense-in-depth for future refactors.
  it("allows DNS hostnames starting with 'fc' (regression: L-1)", () => {
    expect(() => validateWebhookUrl("https://fc.com/webhook")).not.toThrow();
    expect(() => validateWebhookUrl("https://fc-startup.io/x")).not.toThrow();
  });

  it("allows DNS hostnames starting with 'fd' (regression: L-1)", () => {
    expect(() => validateWebhookUrl("https://fd-webhooks.io/x")).not.toThrow();
    expect(() => validateWebhookUrl("https://fdicgov.com/x")).not.toThrow();
  });

  it("allows DNS hostnames starting with 'fe80' substring (regression: L-1)", () => {
    // Hostnames like `fe80-analytics.example.com` happen to start with
    // `fe80` but are not the IPv6 link-local prefix; the structural gate
    // keeps them allowed.
    expect(() => validateWebhookUrl("https://fe80-analytics.example.com/x")).not.toThrow();
  });

  it("still rejects IPv6 ULA literals (fc00::/7)", () => {
    // Confirm the tightened regex still catches canonical ULA addresses.
    expect(() => validateWebhookUrl("http://[fc00::1]/x")).toThrow("private or reserved");
    expect(() => validateWebhookUrl("http://[fd00::abcd]/x")).toThrow("private or reserved");
    expect(() => validateWebhookUrl("http://[fcff:1234::1]/x")).toThrow("private or reserved");
    expect(() => validateWebhookUrl("http://[fdff::1]/x")).toThrow("private or reserved");
  });

  it("still rejects IPv6 link-local literals (fe80::/10)", () => {
    expect(() => validateWebhookUrl("http://[fe80::1]/x")).toThrow("private or reserved");
  });

  it("allows DNS hostnames that start with private-IPv4-looking prefixes", () => {
    // Side effect of the isIP() gate: DNS names like "127.example.com"
    // or "10-minute-mail.com" no longer incidentally match the IPv4
    // private regexes (they never should have — they aren't IPs). True
    // DNS-resolved private addresses are the S2 DNS-form class, deferred
    // to B2.
    expect(() => validateWebhookUrl("https://10-minute-mail.com/x")).not.toThrow();
  });
});

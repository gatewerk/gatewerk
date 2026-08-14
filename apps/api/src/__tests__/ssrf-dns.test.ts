import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import dns from "node:dns";
import { validateWebhookUrlWithDns } from "../lib/ssrf";

describe("validateWebhookUrlWithDns", () => {
  let resolve4Spy: any;
  let resolve6Spy: any;
  let savedSkip: string | undefined;

  beforeEach(() => {
    // Disable the test-env DNS bypass so we can exercise the DNS path with
    // mocked resolve4/resolve6 (mirrors how SKIP_HIBP is handled in the
    // password-policy tests).
    savedSkip = process.env.SKIP_DNS_SSRF;
    delete process.env.SKIP_DNS_SSRF;

    resolve4Spy = vi.spyOn(dns.promises, "resolve4");
    resolve6Spy = vi.spyOn(dns.promises, "resolve6");
  });

  afterEach(() => {
    resolve4Spy.mockRestore();
    resolve6Spy.mockRestore();
    if (savedSkip !== undefined) {
      process.env.SKIP_DNS_SSRF = savedSkip;
    } else {
      delete process.env.SKIP_DNS_SSRF;
    }
  });

  it("passes for a domain resolving to a public IP", async () => {
    resolve4Spy.mockResolvedValue(["93.184.216.34"] as any);
    resolve6Spy.mockRejectedValue(new Error("ENODATA"));

    await expect(validateWebhookUrlWithDns("https://example.com/hook")).resolves.toBeUndefined();
  });

  it("rejects a domain resolving to a loopback IP", async () => {
    resolve4Spy.mockResolvedValue(["127.0.0.1"] as any);
    resolve6Spy.mockRejectedValue(new Error("ENODATA"));

    await expect(validateWebhookUrlWithDns("https://evil.example.com/hook")).rejects.toThrow(
      "must not resolve to a private IP",
    );
  });

  it("rejects a domain resolving to a private 10.x IP", async () => {
    resolve4Spy.mockResolvedValue(["10.0.0.1"] as any);
    resolve6Spy.mockRejectedValue(new Error("ENODATA"));

    await expect(validateWebhookUrlWithDns("https://internal.corp/hook")).rejects.toThrow(
      "must not resolve to a private IP",
    );
  });

  it("rejects a domain resolving to 192.168.x.x", async () => {
    resolve4Spy.mockResolvedValue(["192.168.1.100"] as any);
    resolve6Spy.mockRejectedValue(new Error("ENODATA"));

    await expect(validateWebhookUrlWithDns("https://home.local/hook")).rejects.toThrow(
      "must not resolve to a private IP",
    );
  });

  it("rejects a domain resolving to a link-local IPv6", async () => {
    resolve4Spy.mockRejectedValue(new Error("ENODATA"));
    resolve6Spy.mockResolvedValue(["fe80::1"] as any);

    await expect(validateWebhookUrlWithDns("https://sneaky.example.com/hook")).rejects.toThrow(
      "must not resolve to a private IP",
    );
  });

  it("rejects when any resolved IP is private (mixed results)", async () => {
    resolve4Spy.mockResolvedValue(["93.184.216.34", "127.0.0.1"] as any);
    resolve6Spy.mockRejectedValue(new Error("ENODATA"));

    await expect(validateWebhookUrlWithDns("https://multi.example.com/hook")).rejects.toThrow(
      "must not resolve to a private IP",
    );
  });

  it("rejects when hostname cannot be resolved", async () => {
    resolve4Spy.mockRejectedValue(new Error("ENOTFOUND"));
    resolve6Spy.mockRejectedValue(new Error("ENOTFOUND"));

    await expect(validateWebhookUrlWithDns("https://nonexistent.invalid/hook")).rejects.toThrow(
      "could not be resolved",
    );
  });

  it("skips DNS resolution for IP literal URLs", async () => {
    await expect(validateWebhookUrlWithDns("https://93.184.216.34/hook")).resolves.toBeUndefined();
    expect(resolve4Spy).not.toHaveBeenCalled();
    expect(resolve6Spy).not.toHaveBeenCalled();
  });

  it("still rejects private IP literals (via existing sync check)", async () => {
    await expect(validateWebhookUrlWithDns("https://127.0.0.1/hook")).rejects.toThrow(
      "private or reserved",
    );
  });
});

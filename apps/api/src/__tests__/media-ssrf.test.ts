import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { downloadAndStore } from "../services/media";

// Regression for the SSRF class closed in launch-readiness Phase 1.
// Agent-supplied review media URLs flow directly into fetch() via
// services/reviews/crud.ts → services/media.ts. Before the fix, a malicious
// agent could target cloud metadata endpoints, internal services, and
// loopback. validateWebhookUrl now gates the fetch; any private, reserved,
// or non-HTTP(S) target returns null per the graceful-degradation contract.
//
// Each test asserts BOTH the null return AND that fetch was never invoked.
// The second assertion is load-bearing: without it, a future regression
// that removes the validator or moves it below fetch could still pass all
// cases because many of these hosts would fail the fetch anyway
// (ECONNREFUSED, DNS fail, etc). Proving fetch is NOT called is what
// documents the short-circuit-before-socket security property.
describe("media.downloadAndStore — SSRF guard", () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch") as MockInstance<typeof fetch>;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  async function expectBlocked(url: string) {
    const res = await downloadAndStore(url, "rev_test", "field");
    expect(res).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  }

  it("refuses IPv4 loopback", async () => {
    await expectBlocked("http://127.0.0.1/x");
  });

  it("refuses AWS-style metadata service (169.254.169.254)", async () => {
    await expectBlocked("http://169.254.169.254/latest/meta-data/iam/security-credentials/");
  });

  it("refuses RFC1918 private ranges", async () => {
    await expectBlocked("http://10.0.0.1/x");
    await expectBlocked("http://172.16.0.1/x");
    await expectBlocked("http://192.168.1.1/x");
  });

  it("refuses 0.0.0.0 and CGNAT", async () => {
    await expectBlocked("http://0.0.0.0/x");
    await expectBlocked("http://100.64.0.1/x");
  });

  it("refuses localhost hostname", async () => {
    await expectBlocked("http://localhost/x");
    await expectBlocked("http://localhost:3000/x");
  });

  it("refuses IPv6 loopback", async () => {
    await expectBlocked("http://[::1]/x");
  });

  it("refuses non-HTTP(S) schemes", async () => {
    await expectBlocked("file:///etc/passwd");
    await expectBlocked("ftp://example.com/x");
  });

  it("refuses malformed URLs", async () => {
    await expectBlocked("not-a-url");
    await expectBlocked("");
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS, type AuditAction } from "@gatewerk/shared";
import { createTestDb } from "../../../__tests__/helpers/test-db";
import { createAuditService } from "../../audit";
import { createEmailService, type EmailService } from "../index";
import type { EmailTransport, EmailTransportSendInput } from "../transport";

interface SpyTransport extends EmailTransport {
  __calls: EmailTransportSendInput[];
  __closeCalls: number;
  __setNextFailure: (err: Error | null) => void;
}

/**
 * Test-only spy transport. Captures every send-input for assertions and
 * supports an injected one-shot failure to exercise the failed-status
 * branch without a real SMTP server.
 */
function createSpyTransport(): SpyTransport {
  const calls: EmailTransportSendInput[] = [];
  let nextId = 1;
  let nextFailure: Error | null = null;
  let closeCalls = 0;
  return {
    async send(input) {
      if (nextFailure) {
        const err = nextFailure;
        nextFailure = null;
        throw err;
      }
      calls.push(input);
      return { messageId: `<test-${nextId++}@gatewerk>` };
    },
    async close() {
      closeCalls++;
    },
    get __calls() {
      return calls;
    },
    get __closeCalls() {
      return closeCalls;
    },
    __setNextFailure(err) {
      nextFailure = err;
    },
  };
}

describe("Email service", () => {
  let db: any;
  let auditService: ReturnType<typeof createAuditService>;
  let transport: SpyTransport;
  let emailService: EmailService;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    auditService = createAuditService(db);
  });

  beforeEach(() => {
    transport = createSpyTransport();
    emailService = createEmailService({ audit: auditService, transport });
  });

  afterEach(async () => {
    await emailService.close();
  });

  // Helper to read recent audit rows of a particular action for the email
  // resource type. Test DB is shared across cases, so we filter by action
  // + resource_type + a recency window matched to the test boot.
  async function recentAudit(action: AuditAction): Promise<any[]> {
    const result = await auditService.query({
      action,
      resource_type: "email",
      limit: 100,
    });
    return result.items;
  }

  it("configured-send happy path → status sent + audit succeeded", async () => {
    const beforeCount = (await recentAudit("email.send_succeeded")).length;
    const result = await emailService.sendEmail({
      to: "alice@example.com",
      subject: "Hello",
      text: "plain body",
      html: "<p>html body</p>",
    });

    expect(result.status).toBe("sent");
    if (result.status !== "sent") return; // type narrow
    expect(result.messageId).toMatch(/<test-\d+@gatewerk>/);
    expect(transport.__calls.length).toBe(1);

    const audits = await recentAudit("email.send_succeeded");
    expect(audits.length).toBe(beforeCount + 1);
    const latest = audits[0];
    expect(latest.details.to).toBe("alice@example.com");
    expect(latest.details.subject).toBe("Hello");
    expect(latest.details.message_id).toBe(result.messageId);
    expect(latest.actor).toBe("system:email");
  });

  it("unconfigured → status skipped_no_config + audit skipped + transport NOT called", async () => {
    // No injected transport AND no SMTP_* envs → service installs no-op
    // transport AND short-circuits the send path.
    const unconfiguredService = createEmailService({ audit: auditService });
    const beforeCount = (await recentAudit("email.send_skipped_no_config")).length;

    const result = await unconfiguredService.sendEmail({
      to: "bob@example.com",
      subject: "test",
      text: "t",
      html: "<p>t</p>",
    });
    expect(result.status).toBe("skipped_no_config");
    expect(unconfiguredService.isEmailConfigured()).toBe(false);

    const audits = await recentAudit("email.send_skipped_no_config");
    expect(audits.length).toBe(beforeCount + 1);
    expect(audits[0].details.to).toBe("bob@example.com");
    await unconfiguredService.close();
  });

  it("per-email rate limit → 5 sends ok, 6th rate_limited", async () => {
    const to = "victim@example.com";
    for (let i = 0; i < 5; i++) {
      const r = await emailService.sendEmail({
        to,
        subject: `s${i}`,
        text: "t",
        html: "<p>t</p>",
      });
      expect(r.status).toBe("sent");
    }

    const sixth = await emailService.sendEmail({
      to,
      subject: "s6",
      text: "t",
      html: "<p>t</p>",
    });
    expect(sixth.status).toBe("rate_limited");
    if (sixth.status !== "rate_limited") return;
    expect(sixth.reason).toBe("per_email");
    expect(transport.__calls.length).toBe(5); // 6th never reaches transport
  });

  it("per-IP rate limit → 20 sends ok across distinct emails, 21st rate_limited", async () => {
    const sourceIp = "203.0.113.7";
    for (let i = 0; i < 20; i++) {
      const r = await emailService.sendEmail({
        to: `recipient-${i}@example.com`,
        subject: "s",
        text: "t",
        html: "<p>t</p>",
        sourceIp,
      });
      expect(r.status).toBe("sent");
    }

    const twentyFirst = await emailService.sendEmail({
      to: "recipient-21@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
      sourceIp,
    });
    expect(twentyFirst.status).toBe("rate_limited");
    if (twentyFirst.status !== "rate_limited") return;
    expect(twentyFirst.reason).toBe("per_ip");
  });

  it("per-email vs per-IP independence — same email different IPs trips per-email first", async () => {
    const to = "shared@example.com";
    // 5 sends succeed even from distinct IPs (per-IP budget is 20).
    for (let i = 0; i < 5; i++) {
      const r = await emailService.sendEmail({
        to,
        subject: "s",
        text: "t",
        html: "<p>t</p>",
        sourceIp: `198.51.100.${i + 1}`,
      });
      expect(r.status).toBe("sent");
    }
    // 6th to same recipient from yet another IP should hit per-email cap.
    const sixth = await emailService.sendEmail({
      to,
      subject: "s",
      text: "t",
      html: "<p>t</p>",
      sourceIp: "198.51.100.6",
    });
    expect(sixth.status).toBe("rate_limited");
    if (sixth.status !== "rate_limited") return;
    expect(sixth.reason).toBe("per_email");
  });

  it("idempotency dedup → second send within 60s returns same messageId, transport NOT called", async () => {
    const beforeDeduped = (await recentAudit("email.send_deduped")).length;
    const key = "form-mount-nonce-abc";
    const first = await emailService.sendEmail({
      to: "carol@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
      idempotencyKey: key,
    });
    expect(first.status).toBe("sent");
    if (first.status !== "sent") return;

    const second = await emailService.sendEmail({
      to: "carol@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
      idempotencyKey: key,
    });
    expect(second.status).toBe("deduped");
    if (second.status !== "deduped") return;
    expect(second.messageId).toBe(first.messageId);
    expect(transport.__calls.length).toBe(1); // dedup skips transport

    const audits = await recentAudit("email.send_deduped");
    expect(audits.length).toBe(beforeDeduped + 1);
    expect(audits[0].details.idempotency_key).toBe(key);
  });

  it("transport error → status failed + audit failed, no rethrow", async () => {
    const beforeFailed = (await recentAudit("email.send_failed")).length;
    transport.__setNextFailure(new Error("SMTP 421 service not available"));

    const result = await emailService.sendEmail({
      to: "dave@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toContain("421");

    const audits = await recentAudit("email.send_failed");
    expect(audits.length).toBe(beforeFailed + 1);
    expect(audits[0].details.error).toContain("421");
  });

  it("idempotency expires — same key after 60s window fires fresh send", async () => {
    const key = "expiring-key";
    const first = await emailService.sendEmail({
      to: "expire@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
      idempotencyKey: key,
    });
    expect(first.status).toBe("sent");
    expect(transport.__calls.length).toBe(1);

    // Advance system time past the 60s idempotency window. We use vi's
    // fake-system-time to shift Date.now() since the store reads expiresAt
    // against Date.now() lazily on get.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 70_000);
    try {
      const second = await emailService.sendEmail({
        to: "expire@example.com",
        subject: "s",
        text: "t",
        html: "<p>t</p>",
        idempotencyKey: key,
      });
      expect(second.status).toBe("sent");
      expect(transport.__calls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("default hygiene headers reach transport — List-Unsubscribe + Auto-Submitted", async () => {
    await emailService.sendEmail({
      to: "headers@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
    });
    const lastCall = transport.__calls[transport.__calls.length - 1]!;
    expect(lastCall.headers["List-Unsubscribe"]).toMatch(/^<mailto:.*unsubscribe.*>$/);
    expect(lastCall.headers["Auto-Submitted"]).toBe("auto-generated");
  });

  it("multipart body present — text + html both reach transport", async () => {
    const r = await emailService.sendEmail({
      to: "multipart@example.com",
      subject: "Subject",
      text: "plain version",
      html: "<p>html version</p>",
    });
    expect(r.status).toBe("sent");
    const lastCall = transport.__calls[transport.__calls.length - 1]!;
    expect(lastCall.text).toBe("plain version");
    expect(lastCall.html).toBe("<p>html version</p>");
    expect(lastCall.subject).toBe("Subject");
  });

  it("close() cascades to transport.close()", async () => {
    expect(transport.__closeCalls).toBe(0);
    await emailService.close();
    expect(transport.__closeCalls).toBe(1);
    // afterEach will close again — spy must accept multiple closes safely.
  });

  it("AUDIT_ACTIONS shared enum exposes all 5 new email events", () => {
    const required: AuditAction[] = [
      "email.send_succeeded",
      "email.send_failed",
      "email.send_skipped_no_config",
      "email.rate_limited",
      "email.send_deduped",
    ];
    for (const action of required) {
      expect((AUDIT_ACTIONS as readonly string[]).includes(action)).toBe(true);
    }
  });

  // NT1 — F1 regression: idempotency dedup is recipient-scoped. Prior shape
  // composed the dedup key from idempotencyKey alone, so a form-mount nonce
  // reused across recipients would silently return the first recipient's
  // messageId for a different `to` and skip the SMTP send entirely.
  it("idempotency dedup is recipient-scoped — same key to different recipient sends fresh", async () => {
    const key = "shared-key";
    const callsBefore = transport.__calls.length;
    const first = await emailService.sendEmail({
      to: "alice@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
      idempotencyKey: key,
    });
    expect(first.status).toBe("sent");
    if (first.status !== "sent") return;
    const second = await emailService.sendEmail({
      to: "bob@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
      idempotencyKey: key,
    });
    expect(second.status).toBe("sent");
    if (second.status !== "sent") return;
    expect(second.messageId).not.toBe(first.messageId);
    expect(transport.__calls.length).toBe(callsBefore + 2);
  });

  // NT2 — F2 regression (success path): an audit-emit failure must not
  // escape the "NEVER throws" invariant. sendEmail still returns
  // { status: "sent" } even when audit.log rejects.
  it("audit.log throwing on success path: sendEmail still returns { status: 'sent' }", async () => {
    const failingAudit = {
      ...auditService,
      log: vi.fn().mockRejectedValue(new Error("audit DB down")),
    };
    const svc = createEmailService({
      audit: failingAudit as any,
      transport,
    });
    const result = await svc.sendEmail({
      to: "audit-fail-success@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
    });
    expect(result.status).toBe("sent");
  });

  // NT2 — F2 regression (failure path): audit-emit failure must not
  // replace the SMTP error message in the returned `failed` result.
  it("audit.log throwing on failure path: sendEmail still returns the SMTP error message, not the audit error", async () => {
    const failingTransport: EmailTransport = {
      send: vi.fn().mockRejectedValue(new Error("SMTP timeout")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const failingAudit = {
      ...auditService,
      log: vi.fn().mockRejectedValue(new Error("audit DB down")),
    };
    const svc = createEmailService({
      audit: failingAudit as any,
      transport: failingTransport,
    });
    const result = await svc.sendEmail({
      to: "audit-fail-failure@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toContain("SMTP timeout");
    expect(result.error).not.toContain("audit DB down");
  });

  // NT3 — `email.rate_limited` audit row carries reason + identifier so
  // ops can reconstruct which axis tripped from audit_log alone.
  it("rate_limited audit row records per_email reason + recipient", async () => {
    const to = "audit-shape-email@example.com";
    for (let i = 0; i < 5; i++) {
      const r = await emailService.sendEmail({
        to,
        subject: "s",
        text: "t",
        html: "<p>t</p>",
      });
      expect(r.status).toBe("sent");
    }
    const beforeRows = (await recentAudit("email.rate_limited")).length;
    const sixth = await emailService.sendEmail({
      to,
      subject: "s",
      text: "t",
      html: "<p>t</p>",
    });
    expect(sixth.status).toBe("rate_limited");
    const auditRows = await recentAudit("email.rate_limited");
    expect(auditRows.length).toBe(beforeRows + 1);
    expect(auditRows[0].details).toMatchObject({
      reason: "per_email",
      to,
    });
  });

  it("rate_limited audit row records per_ip reason + source_ip", async () => {
    const sourceIp = "203.0.113.42";
    for (let i = 0; i < 20; i++) {
      const r = await emailService.sendEmail({
        to: `audit-ip-shape-${i}@example.com`,
        subject: "s",
        text: "t",
        html: "<p>t</p>",
        sourceIp,
      });
      expect(r.status).toBe("sent");
    }
    const beforeRows = (await recentAudit("email.rate_limited")).length;
    const twentyFirst = await emailService.sendEmail({
      to: "audit-ip-shape-21@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
      sourceIp,
    });
    expect(twentyFirst.status).toBe("rate_limited");
    const auditRows = await recentAudit("email.rate_limited");
    expect(auditRows.length).toBe(beforeRows + 1);
    expect(auditRows[0].details).toMatchObject({
      reason: "per_ip",
      source_ip: sourceIp,
    });
  });

  // NT4 — Cross-axis ordering: per-email cap is checked BEFORE per-IP, so
  // a single recipient's per-email budget must trip before per-IP can
  // accumulate to its 20-cap from cross-recipient sends. Verifies the
  // dual-axis ordering documented in services/email/index.ts branch 3a/3b.
  it("per-IP cap accumulates across recipients independently of per-email", async () => {
    const sourceIp = "203.0.113.99";
    // 20 sends to 20 distinct recipients from one IP — per-email budget
    // (5) is per-recipient so it is not consumed by the cross-recipient
    // pattern; per-IP budget (20) consumes here.
    for (let i = 0; i < 20; i++) {
      const r = await emailService.sendEmail({
        to: `cross-axis-${i}@example.com`,
        subject: "s",
        text: "t",
        html: "<p>t</p>",
        sourceIp,
      });
      expect(r.status).toBe("sent");
    }
    // 21st distinct recipient from same IP must hit per-IP cap, NOT per-email.
    const tripped = await emailService.sendEmail({
      to: "cross-axis-21@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
      sourceIp,
    });
    expect(tripped.status).toBe("rate_limited");
    if (tripped.status !== "rate_limited") return;
    expect(tripped.reason).toBe("per_ip");
  });

  // NT5 — close() idempotency. afterEach also calls close, so any test
  // that closes mid-body must tolerate the trailing afterEach call.
  it("close() is idempotent — second close does not throw", async () => {
    await emailService.close();
    await expect(emailService.close()).resolves.not.toThrow();
  });

  // NT6 — F6 regression: case variants of the same recipient must share
  // the per-email rate-limit budget. Prior shape used the raw `to` string
  // as the rate-limit key, so an attacker could rotate Alice@/ALICE@ to
  // bypass the 5-per-recipient cap.
  it("rate limit treats case variants as the same recipient", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await emailService.sendEmail({
        to: "case-variant@example.com",
        subject: "s",
        text: "t",
        html: "<p>t</p>",
      });
      expect(r.status).toBe("sent");
    }
    const sixth = await emailService.sendEmail({
      to: "CASE-VARIANT@Example.COM",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
    });
    expect(sixth.status).toBe("rate_limited");
    if (sixth.status !== "rate_limited") return;
    expect(sixth.reason).toBe("per_email");
  });

  // NT7 — F11 regression: header-injection defense. CRLF in `to` is
  // rejected as an attack rather than sanitized — sanitizing would hide
  // the attempt from audit_log, defeating ops' ability to catch caller-
  // input misuse upstream. CRLF in `subject` is folded to a space because
  // subjects are MIME-encoded and benign-foldable, no need for hard reject.
  it("rejects to with CRLF (header injection defense)", async () => {
    const callsBefore = transport.__calls.length;
    const beforeFailed = (await recentAudit("email.send_failed")).length;
    const result = await emailService.sendEmail({
      to: "victim@example.com\r\nBcc: attacker@evil.com",
      subject: "OTP",
      text: "t",
      html: "<p>t</p>",
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toContain("header_injection_detected");
    expect(transport.__calls.length).toBe(callsBefore);
    const audits = await recentAudit("email.send_failed");
    expect(audits.length).toBe(beforeFailed + 1);
    expect(audits[0].details.error).toBe("header_injection_detected");
  });

  it("normalizes CRLF in subject to spaces (no header injection)", async () => {
    const result = await emailService.sendEmail({
      to: "subject-crlf@example.com",
      subject: "OTP\r\nBcc: attacker@evil.com",
      text: "t",
      html: "<p>t</p>",
    });
    expect(result.status).toBe("sent");
    if (result.status !== "sent") return;
    const lastCall = transport.__calls[transport.__calls.length - 1]!;
    expect(lastCall.subject).not.toContain("\r");
    expect(lastCall.subject).not.toContain("\n");
  });

  describe("sendTestEmail (admin diagnostic path)", () => {
    it("happy path → status sent + audit email.test_sent emitted with system actor", async () => {
      const beforeCount = (await recentAudit("email.test_sent")).length;
      const result = await emailService.sendTestEmail({
        to: "diag@example.com",
        subject: "Gatewerk test",
        text: "hi",
        html: "<p>hi</p>",
      });
      expect(result.status).toBe("sent");
      const audits = await recentAudit("email.test_sent");
      expect(audits.length).toBe(beforeCount + 1);
      expect(audits[0].actor).toBe("system:email");
    });

    it("transport failure → status failed + audit email.test_failed with error verbatim", async () => {
      transport.__setNextFailure(new Error("EAUTH: bad creds"));
      const beforeCount = (await recentAudit("email.test_failed")).length;
      const result = await emailService.sendTestEmail({
        to: "diag@example.com",
        subject: "s",
        text: "t",
        html: "<p>t</p>",
      });
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.error).toContain("EAUTH");
      const audits = await recentAudit("email.test_failed");
      expect(audits.length).toBe(beforeCount + 1);
      expect(audits[0].details.error).toContain("EAUTH");
    });

    it("unconfigured service → status skipped_no_config + audit email.test_skipped_no_config", async () => {
      const unconfigured = createEmailService({ audit: auditService });
      const beforeCount = (await recentAudit("email.test_skipped_no_config")).length;
      const result = await unconfigured.sendTestEmail({
        to: "diag@example.com",
        subject: "s",
        text: "t",
        html: "<p>t</p>",
      });
      expect(result.status).toBe("skipped_no_config");
      const audits = await recentAudit("email.test_skipped_no_config");
      expect(audits.length).toBe(beforeCount + 1);
      await unconfigured.close();
    });

    it("transport_timeout when transport.send hangs past the cap", async () => {
      // Replace transport with one whose send() never resolves; the service-
      // level Promise.race against the 15s cap must reject with transport_timeout.
      const hangingTransport: EmailTransport = {
        send: () => new Promise(() => {}),
        close: async () => {},
      };
      const hangingService = createEmailService({ audit: auditService, transport: hangingTransport });

      vi.useFakeTimers();
      try {
        const resultPromise = hangingService.sendTestEmail({
          to: "diag@example.com",
          subject: "s",
          text: "t",
          html: "<p>t</p>",
        });
        // Advance fake time past the 15s cap.
        await vi.advanceTimersByTimeAsync(16_000);
        const result = await resultPromise;
        expect(result.status).toBe("failed");
        if (result.status === "failed") expect(result.error).toBe("transport_timeout");
      } finally {
        vi.useRealTimers();
        await hangingService.close();
      }
    });

    it("bypasses rate-limit + idempotency that gate sendEmail", async () => {
      // Same dedup key + same recipient called 3× would normally trip dedup
      // on sendEmail. sendTestEmail must NOT consult either store.
      const calls0 = transport.__calls.length;
      for (let i = 0; i < 3; i++) {
        const r = await emailService.sendTestEmail({
          to: "same@example.com",
          subject: "test",
          text: "t",
          html: "<p>t</p>",
        });
        expect(r.status).toBe("sent");
      }
      expect(transport.__calls.length - calls0).toBe(3);
    });

    it("getTransportKind reports smtp for injected transport, none for unconfigured", async () => {
      expect(emailService.getTransportKind()).toBe("smtp");
      const unconfigured = createEmailService({ audit: auditService });
      expect(unconfigured.getTransportKind()).toBe("none");
      await unconfigured.close();
    });
  });

  it("AUDIT_ACTIONS includes the 3 new email.test_* actions", () => {
    const required: AuditAction[] = [
      "email.test_sent",
      "email.test_failed",
      "email.test_skipped_no_config",
    ];
    for (const action of required) {
      expect((AUDIT_ACTIONS as readonly string[]).includes(action)).toBe(true);
    }
  });

  // NT8 — F3 regression: __resetForTesting is no longer part of the
  // production interface for either limiter or store. This test
  // documents the negative-shape so a future re-introduction would
  // need to be intentional. The compile-time absence is enforced via
  // the imported types in the source-tree files; this body just keeps
  // the intent in the test surface.
  it("RateLimiter + IdempotencyStore expose no __resetForTesting", async () => {
    // Module-level shape audit: the imported source files do not export
    // a reset hook on the public interface. The factories are imported
    // for their type identity only.
    const rateLimitMod = await import("../rate-limit");
    const idempotencyMod = await import("../idempotency");
    const limiter = rateLimitMod.createRateLimiter();
    const store = idempotencyMod.createIdempotencyStore();
    expect((limiter as any).__resetForTesting).toBeUndefined();
    expect((store as any).__resetForTesting).toBeUndefined();
  });
});

describe("createEmailSender factory", () => {
  it("returns NodemailerEmailSender by default (standalone mode)", async () => {
    const { createEmailSender } = await import("../index");
    const sender = await createEmailSender({
      mode: "standalone",
      smtpConfig: { host: "localhost", port: 25, secure: false, from: "test@local" },
    });
    // NodemailerEmailSender exposes a `close` method; ResendEmailSender does not.
    expect(typeof (sender as { close?: unknown }).close).toBe("function");
  });

  it("falls back to NodemailerEmailSender when mode=cloud but RESEND_API_KEY is missing", async () => {
    const { createEmailSender } = await import("../index");
    const sender = await createEmailSender({
      mode: "cloud",
      resendApiKey: undefined,
      smtpConfig: { host: "localhost", port: 25, secure: false, from: "test@local" },
    });
    expect(typeof (sender as { close?: unknown }).close).toBe("function");
  });
});

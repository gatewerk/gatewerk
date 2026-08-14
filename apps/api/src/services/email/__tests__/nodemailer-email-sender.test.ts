import { describe, it, expect, vi } from "vitest";
import { NodemailerEmailSender } from "../nodemailer-email-sender";
import { emailSenderContract } from "./email-sender-contract";

// Mock nodemailer so tests don't need a real SMTP server.
// The mock factory is invoked once per createTransport() call. Idempotency
// is exercised by the NodemailerEmailSender's instance-scoped memCache, so
// each contract test that constructs a fresh sender gets a clean dedup
// store (matches the production "fresh process boot" condition).
vi.mock("nodemailer", () => {
  const createTransport = vi.fn(() => {
    let callCount = 0;
    const sentByRecipient = new Map<string, string>();
    return {
      sendMail: vi.fn(async (opts: { to: string }) => {
        if (!opts.to || opts.to.trim().length === 0) {
          throw new Error("Invalid recipient");
        }
        callCount++;
        const id = `<msg-${callCount}@gatewerk.local>`;
        sentByRecipient.set(opts.to, id);
        return { messageId: id };
      }),
      verify: vi.fn(async () => true),
      close: vi.fn(),
    };
  });
  return { default: { createTransport } };
});

const BASE_CONFIG = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  from: "noreply@gatewerk.local",
};

// Run the shared contract suite (no db → in-memory idempotency fallback)
emailSenderContract("nodemailer", (opts) => {
  if (opts?.mode === "broken") {
    // Inject a transporter mock whose verify() throws to exercise the unhealthy-backend contract
    const brokenSender = new NodemailerEmailSender(BASE_CONFIG);
    (brokenSender as any).transporter.verify = vi.fn(async () => { throw new Error("smtp_unreachable"); });
    return brokenSender;
  }
  return new NodemailerEmailSender(BASE_CONFIG);
});

describe("NodemailerEmailSender — additional unit cases", () => {
  it("close() does not throw", async () => {
    const sender = new NodemailerEmailSender(BASE_CONFIG);
    await expect(sender.close()).resolves.toBeUndefined();
  });

  it("adds List-Unsubscribe and Auto-Submitted hygiene headers", async () => {
    const nodemailer = await import("nodemailer");
    const createTransportMock = nodemailer.default.createTransport as ReturnType<typeof vi.fn>;
    const callsBefore = createTransportMock.mock.results.length;
    const sender = new NodemailerEmailSender(BASE_CONFIG);
    const transportMock = createTransportMock.mock.results[callsBefore]?.value;

    await sender.send({
      to: "test@example.com",
      from: "noreply@gatewerk.local",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    const call = transportMock.sendMail.mock.calls.at(-1)?.[0];
    expect(call.headers["List-Unsubscribe"]).toContain("unsubscribe");
    expect(call.headers["Auto-Submitted"]).toBe("auto-generated");
  });

  it("caller cannot override List-Unsubscribe / Auto-Submitted hygiene headers", async () => {
    const nodemailer = await import("nodemailer");
    const createTransportMock = nodemailer.default.createTransport as ReturnType<typeof vi.fn>;
    const callsBefore = createTransportMock.mock.results.length;
    const sender = new NodemailerEmailSender(BASE_CONFIG);
    const transportMock = createTransportMock.mock.results[callsBefore]?.value;

    await sender.send({
      to: "test@example.com",
      from: "noreply@gatewerk.local",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
      headers: {
        "List-Unsubscribe": "<https://attacker.example.com/track>",
        "Auto-Submitted": "no",
        "X-Custom-Allowed": "yes",
      },
    });

    const call = transportMock.sendMail.mock.calls.at(-1)?.[0];
    // Hygiene defaults win; caller's malicious override does NOT
    expect(call.headers["List-Unsubscribe"]).toContain("mailto:");
    expect(call.headers["List-Unsubscribe"]).not.toContain("attacker.example.com");
    expect(call.headers["Auto-Submitted"]).toBe("auto-generated");
    // Non-hygiene custom headers still pass through
    expect(call.headers["X-Custom-Allowed"]).toBe("yes");
  });
});

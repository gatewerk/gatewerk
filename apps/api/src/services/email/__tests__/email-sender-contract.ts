import { describe, it, expect, vi } from "vitest";
import type { EmailSender, EmailEnvelope } from "../email-sender";

/**
 * Shared behavioural contract for all EmailSender implementations.
 * Import this factory in adapter-specific test files and invoke it
 * with a factory that returns a fresh adapter instance.
 *
 * Usage:
 *   import { emailSenderContract } from ".../email-sender-contract";
 *   emailSenderContract("nodemailer", () => new NodemailerEmailSender(...));
 */
export function emailSenderContract(
  adapterName: string,
  factory: (opts?: { mode?: "broken" }) => EmailSender,
): void {
  describe(`EmailSender contract — ${adapterName}`, () => {
    function validEnvelope(overrides: Partial<EmailEnvelope> = {}): EmailEnvelope {
      return {
        to: "alice@example.com",
        from: "noreply@gatewerk.local",
        subject: "Test subject",
        html: "<p>Hello</p>",
        text: "Hello",
        ...overrides,
      };
    }

    it("resolves with messageId, provider, and sentAt on success", async () => {
      const sender = factory();
      const result = await sender.send(validEnvelope());

      expect(result).toMatchObject({
        messageId: expect.any(String),
        provider: adapterName,
        sentAt: expect.any(Date),
      });
      expect(result.messageId.length).toBeGreaterThan(0);
    });

    it("uses the idempotencyKey to deduplicate sends", async () => {
      const sender = factory();
      const envelope = validEnvelope({ idempotencyKey: "unique-key-abc" });

      const first = await sender.send(envelope);
      const second = await sender.send(envelope);

      expect(second.messageId).toBe(first.messageId);
      expect(second.sentAt).toEqual(first.sentAt);
    });

    it("treats different recipients with same idempotencyKey as distinct sends", async () => {
      const sender = factory();
      const key = "shared-key-123";

      const first = await sender.send(validEnvelope({ to: "alice@example.com", idempotencyKey: key }));
      const second = await sender.send(validEnvelope({ to: "bob@example.com", idempotencyKey: key }));

      expect(second.messageId).not.toBe(first.messageId);
    });

    it("rejects with an error for an invalid recipient address", async () => {
      const sender = factory();
      await expect(
        sender.send(validEnvelope({ to: "" }))
      ).rejects.toThrow();
    });

    it("verifyConfiguration returns { ok: true } on green path", async () => {
      const sender = factory();
      const result = await sender.verifyConfiguration();

      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("verifyConfiguration returns { ok: false } on unhealthy backend (never throws)", async () => {
      const sender = factory({ mode: "broken" });
      const result = await sender.verifyConfiguration();
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe("string");
    });
  });
}

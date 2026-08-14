import nodemailer, { type Transporter } from "nodemailer";
import type SMTPPool from "nodemailer/lib/smtp-pool/index.js";
import type { AppDb } from "@gatewerk/db";
import { sql } from "drizzle-orm";
import type { EmailEnvelope, DeliveryResult, EmailSender } from "./email-sender";

export interface NodemailerEmailSenderConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/**
 * OSS EmailSender implementation using Nodemailer pooled SMTP.
 *
 * Idempotency: stored in Postgres `email_idempotency_keys` (24h TTL) via
 * the injected `db`. The dedup key is composite `${normalizedTo}:${idempotencyKey}`
 * — same scoping as the legacy in-memory store so a key reused across different
 * recipients does not cross-contaminate. When `db` is omitted (e.g. in unit
 * tests that inject a spy transport), idempotency degrades to per-instance
 * in-memory Map with no TTL (instance-scoped to prevent cross-test pollution
 * — module-scoped fallback caches let test cases share dedup state).
 *
 * Errors from SMTP are returned as rejected Promises with the original Error
 * — the interface contract forbids swallowing. Empty `to` throws synchronously
 * before any IO (programmer error).
 */
export class NodemailerEmailSender implements EmailSender {
  private transporter: Transporter<SMTPPool.SentMessageInfo>;
  private from: string;
  private db: AppDb | undefined;
  /** Fallback in-memory cache when db is absent (test / fire-and-forget mode).
   *  Instance-scoped (NOT module-scoped) to prevent cross-test pollution —
   *  module-scoped fallback caches let test cases share dedup state. */
  private memCache = new Map<string, { messageId: string; sentAt: Date }>();

  constructor(config: NodemailerEmailSenderConfig, db?: AppDb) {
    const auth =
      config.user && config.pass
        ? { user: config.user, pass: config.pass }
        : undefined;

    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      auth,
    });
    this.from = config.from;
    this.db = db;
  }

  async send(envelope: EmailEnvelope): Promise<DeliveryResult> {
    if (!envelope.to || envelope.to.trim().length === 0) {
      throw new Error("NodemailerEmailSender: `to` field must not be empty");
    }

    const normalizedTo = envelope.to.trim().toLowerCase();

    if (envelope.idempotencyKey) {
      const dedupKey = `${normalizedTo}:${envelope.idempotencyKey}`;
      const cached = await this.lookupIdempotency(dedupKey);
      if (cached) return cached;
    }

    const headers: Record<string, string> = {
      ...envelope.headers,
      // Hygiene headers spread LAST so callers cannot override RFC-required values
      "List-Unsubscribe": `<mailto:${this.from}?subject=unsubscribe>`,
      "Auto-Submitted": "auto-generated",
    };

    const info = await this.transporter.sendMail({
      from: envelope.from ?? this.from,
      to: normalizedTo,
      subject: envelope.subject,
      html: envelope.html,
      text: envelope.text,
      replyTo: envelope.replyTo,
      headers,
    });

    const result: DeliveryResult = {
      messageId: info.messageId,
      provider: "nodemailer",
      sentAt: new Date(),
    };

    if (envelope.idempotencyKey) {
      const dedupKey = `${normalizedTo}:${envelope.idempotencyKey}`;
      await this.storeIdempotency(dedupKey, result);
    }

    return result;
  }

  async verifyConfiguration(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.transporter.verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async lookupIdempotency(key: string): Promise<DeliveryResult | null> {
    if (this.db) {
      const result = await this.db.execute(
        sql`SELECT message_id, created_at FROM email_idempotency_keys WHERE id = ${key} AND created_at > now() - interval '24 hours' LIMIT 1`
      );
      const rows = (result as unknown as { rows: Array<{ message_id: string; created_at: string }> }).rows;
      const row = rows[0];
      if (row) {
        return { messageId: row.message_id, provider: "nodemailer", sentAt: new Date(row.created_at) };
      }
    } else {
      const cached = this.memCache.get(key);
      if (cached) return { ...cached, provider: "nodemailer" };
    }
    return null;
  }

  private async storeIdempotency(key: string, result: DeliveryResult): Promise<void> {
    if (this.db) {
      await this.db.execute(
        // sentAt is a JS Date and this is a raw fragment, so it must be an ISO
        // string with an explicit cast. Bound as a Date it reaches postgres.js
        // untyped and throws ERR_INVALID_ARG_TYPE at Bind — the same defect
        // that silently killed the hourly email-pause evaluator in production
        // (see apps/api/src/jobs/email-pause-evaluator.ts). Tests run on
        // PGlite, which accepts a Date here, so nothing would have failed.
        sql`INSERT INTO email_idempotency_keys (id, message_id, created_at) VALUES (${key}, ${result.messageId}, ${result.sentAt.toISOString()}::timestamptz) ON CONFLICT (id) DO NOTHING`
      );
    } else {
      this.memCache.set(key, { messageId: result.messageId, sentAt: result.sentAt });
    }
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}

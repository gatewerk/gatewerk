/**
 * EmailEnvelope — everything needed to send one transactional message.
 *
 * `idempotencyKey` is caller-supplied dedup key. The implementation stores
 * it in Postgres `email_idempotency_keys` (24h TTL) so duplicate form
 * submissions / retries across server restarts are absorbed.
 *
 * `replyTo` and `headers` are forwarded verbatim to the provider.
 */
export interface EmailEnvelope {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

/**
 * DeliveryResult — success shape returned when the provider accepted the
 * message. `provider` discriminates for logging/metrics.
 */
export interface DeliveryResult {
  messageId: string;
  provider: "nodemailer" | "resend";
  sentAt: Date;
}

/**
 * EmailSender — thin contract that OSS (Nodemailer) and Cloud (Resend)
 * adapters implement. Both impls share the contract test suite in
 * `__tests__/email-sender-contract.ts`.
 *
 * `send()` rejects with the provider error on failure; programmer-error
 * cases (empty `to`, etc) throw synchronously before any IO.
 *
 * `verifyConfiguration()` pings the provider to confirm credentials and
 * connectivity are valid. Used by the admin diagnostics endpoint.
 */
export interface EmailSender {
  send(envelope: EmailEnvelope): Promise<DeliveryResult>;
  verifyConfiguration(): Promise<{ ok: boolean; error?: string }>;
}

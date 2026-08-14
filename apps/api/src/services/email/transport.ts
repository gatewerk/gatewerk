import nodemailer from "nodemailer";

/**
 * Transport abstraction for the email service. The service layer holds the
 * pool, rate-limit, idempotency, and audit responsibilities; the transport
 * is purely "given these multipart contents, hand bytes to SMTP." Two
 * implementations:
 *
 *   - createNodemailerTransport: production path, uses nodemailer's pooled
 *     SMTP transport (5 connections, 100 messages/connection ceiling per
 *     nodemailer 6.x guidance for high-volume senders).
 *   - createNoOpTransport: defense-in-depth — should never be invoked when
 *     the service has a configured transport, but guards against a logic
 *     bug where the configured-check is bypassed.
 */
export interface EmailTransportSendInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  from: string;
  headers: Record<string, string>;
}

export interface EmailTransport {
  send(input: EmailTransportSendInput): Promise<{ messageId: string }>;
  close(): Promise<void>;
}

export interface NodemailerTransportConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | undefined;
  pass: string | undefined;
  from: string;
}

/**
 * Production SMTP transport. nodemailer pool semantics:
 *   - pool: true             — reuse TCP connections across sends
 *   - maxConnections: 5      — concurrent connections cap (provider-friendly)
 *   - maxMessages: 100       — recycle connection after 100 messages
 *
 * The transport forwards input.headers verbatim — header policy (defaults
 * + caller overrides) lives in the service layer (services/email/index.ts).
 * This shim is provider-neutral so future adapters (e.g. Resend at Cloud
 * Solo M30) can implement EmailTransport 1:1 without re-implementing
 * hygiene-header policy.
 */
export function createNodemailerTransport(
  smtpConfig: NodemailerTransportConfig,
): EmailTransport {
  const auth =
    smtpConfig.user && smtpConfig.pass
      ? { user: smtpConfig.user, pass: smtpConfig.pass }
      : undefined;

  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    // Nodemailer defaults are "wait indefinitely" — a misconfigured SMTP host
    // that accepts TCP but never sends the 220 greeting hangs sendMail forever.
    // Cap each phase so a diagnostic Send-test or a production send fails fast
    // with a useful error rather than a stuck request.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth,
  });

  return {
    async send(input) {
      // Hygiene headers (List-Unsubscribe, Auto-Submitted) are assembled
      // at the service layer — see services/email/index.ts. Transport is
      // a thin SMTP shim and only forwards what it's given.
      const info = await transporter.sendMail({
        from: input.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
        headers: input.headers,
      });
      return { messageId: info.messageId };
    },
    async close() {
      await transporter.close();
    },
  };
}

/**
 * Resend transport, loaded from the private ee submodule on first send.
 *
 * The implementation is Cloud-only and lives in ee/api/adapters/resend-transport.ts.
 * It cannot be imported statically from here — that is the one-way import rule,
 * and the `resend` package is not a dependency of this app any more.
 *
 * Lazy rather than async because createEmailService is synchronous and has
 * fifteen call sites. EmailTransport.send is already async, so the import can
 * happen on first use and nothing upstream has to change shape. The module is
 * cached after the first load, so a burst of sends does one import.
 *
 * A caller that reaches this in standalone mode has a bug: index.ts only
 * selects it when mode is cloud. The failure is then a module-not-found at
 * send time, which is loud and traceable, rather than a silent fallback.
 */
export function createEeResendTransport(apiKey: string): EmailTransport {
  let loaded: Promise<EmailTransport> | null = null;

  const load = (): Promise<EmailTransport> => {
    // Absolute URL, not a bare relative string — see mountEeIfCloud in app.ts
    // for why every ee seam in this repo has to be built from import.meta.url.
    const specifier = (): string =>
      new URL("../../../../../ee/api/adapters/resend-transport.js", import.meta.url).href;
    loaded ??= import(specifier()).then(
      (m: { createResendTransport: (k: string) => EmailTransport }) =>
        m.createResendTransport(apiKey),
    );
    return loaded;
  };

  return {
    async send(input) {
      return (await load()).send(input);
    },
    async close() {
      // Only close what was actually opened. Closing here would otherwise
      // trigger the very import this transport exists to defer.
      if (loaded) await (await loaded).close();
    },
  };
}

/**
 * No-op transport. Intentionally throws on `send` — should never be
 * reached in practice because the email service short-circuits with
 * `{ status: "skipped_no_config" }` before calling the transport when
 * SMTP is unconfigured. Used as the placeholder transport at boot when
 * `isEmailConfigured()` is false; a `send` call here means the config
 * gate has a logic bug and we want a loud failure surface, not silent
 * data loss.
 */
export function createNoOpTransport(): EmailTransport {
  return {
    async send() {
      throw new Error(
        "createNoOpTransport: send() invoked despite unconfigured SMTP. " +
          "isEmailConfigured() gate bypassed — caller logic bug.",
      );
    },
    async close() {
      // Nothing to close.
    },
  };
}

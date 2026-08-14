import { config } from "../../config";
import type { EmailTransportKind } from "@gatewerk/shared";
import type { createAuditService } from "../audit";
import { createIdempotencyStore } from "./idempotency";
import { createRateLimiter } from "./rate-limit";
import {
  type EmailTransport,
  createNodemailerTransport,
  createEeResendTransport,
  createNoOpTransport,
} from "./transport";
import type { EmailSender } from "./email-sender";
import { NodemailerEmailSender, type NodemailerEmailSenderConfig } from "./nodemailer-email-sender";
import type { AppDb } from "@gatewerk/db";
import type { GatewerkMode } from "@gatewerk/shared";

/** Test path timeout. Prevents a stuck SMTP greeting (no 220) from hanging the
 *  Send-test diagnostic indefinitely — the request must always resolve so the
 *  admin gets a result chip rather than an infinite spinner. */
const SEND_TEST_TIMEOUT_MS = 15_000;

/**
 * Email service — OSS-tier transactional sender (SMTP via nodemailer pool).
 *
 * Architecture:
 *   route handler → emailService.sendEmail({ to, subject, text, html, idempotencyKey?, sourceIp? })
 *                  ├─ isEmailConfigured() gate          → skipped_no_config
 *                  ├─ idempotency lookup (60s window)   → deduped
 *                  ├─ per-email + per-IP rate limit     → rate_limited
 *                  ├─ transport.send() → SMTP           → sent
 *                  └─ transport.send() throws           → failed (no rethrow)
 *
 * Key invariant: sendEmail NEVER throws. Every outcome is a discriminated
 * union member. silent-failure-hunter caught throwing-instead-of-returning
 * 4 PRs in a row in adjacent feature work; we make the outcome shape
 * explicit so consumer routes handle each branch.
 *
 * Audit events fire on every branch — OSS operators without an SMTP
 * provider dashboard reconstruct delivery state from audit_log. Audit emits
 * are wrapped in `safeAudit()` so a transient audit-write failure cannot
 * escape the "NEVER throws" invariant — the send path's actual SMTP error
 * is preserved on the failure return regardless of audit outcome.
 *
 * OSS scope: in-memory rate-limit + idempotency (single-instance). A future
 * high-volume deployment can layer Redis-backed implementations via the
 * injected interfaces.
 */

/**
 * Audit-emit guard. `sendEmail` MUST NEVER throw — auditService.log() is
 * a DB write and can fail transiently. Catch-and-log so audit failures
 * do not propagate up and replace the SMTP error message in failure
 * returns. Surfaces to console.error so ops still sees the audit incident.
 */
async function safeAudit(emit: () => Promise<unknown>): Promise<void> {
  try {
    await emit();
  } catch (e) {
    console.error("[email] audit emit failed; continuing", e);
  }
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Optional caller-supplied dedup key (60s window). Typically a per-form-mount nonce. */
  idempotencyKey?: string;
  /** Optional source IP for the per-IP rate-limit axis. */
  sourceIp?: string;
  /**
   * Stream routing hint. When false, routes through the notify sender address
   * (SMTP_FROM_NOTIFY) — appropriate for batched/marketing-adjacent emails such
   * as daily digests. Defaults to true (transactional) so calls that omit the
   * flag use the reputation-sensitive tx sender address (SMTP_FROM_TX).
   */
  is_transactional?: boolean;
  /**
   * RFC 8058 one-click unsubscribe URL. When set, the service emits:
   *   List-Unsubscribe: <url>, <mailto:...?subject=unsubscribe>
   *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
   * When NOT set (transactional emails), only the mailto-form is emitted
   * and List-Unsubscribe-Post is omitted entirely.
   */
  listUnsubscribeUrl?: string;
  /**
   * Owning tenant, when the caller can attribute one. Drives the deliverability
   * breaker and the send log. Omitted means unattributed, which is never gated.
   */
  organization_id?: string | null;
  /**
   * The notification this send is delivering, when the caller can attribute
   * one. Threaded onto the send log row so a later bounce can be traced back
   * to the review it was supposed to notify about (Task 6). Omitted or null
   * means unattributed — a bounce on that row simply cannot be correlated to
   * a specific notification.
   */
  notification_id?: string | null;
}

export type SendEmailResult =
  | { status: "sent"; messageId: string }
  | { status: "skipped_no_config" }
  | { status: "suppressed" }
  | { status: "rate_limited"; reason: "per_email" | "per_ip" }
  | { status: "deduped"; messageId: string }
  | { status: "failed"; error: string }
  | { status: "tenant_paused" };

/** Test path bypasses rate-limit, idempotency, and suppression, so
 *  `rate_limited`, `deduped`, and `suppressed` branches from SendEmailResult
 *  can never occur here. It also never carries an organization_id, so the
 *  deliverability breaker never fires and `tenant_paused` can never occur. */
export type SendTestEmailResult = Exclude<
  SendEmailResult,
  | { status: "rate_limited" }
  | { status: "deduped" }
  | { status: "suppressed" }
  | { status: "tenant_paused" }
>;

export interface EmailService {
  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;
  /**
   * Admin-driven test send. Bypasses rate-limit + idempotency so the same admin
   * can hammer the button while debugging an outbound delivery problem. Emits
   * `email.test_*` audit actions distinct from production sends so the audit
   * log doesn't conflate diagnostic traffic with real transactional volume.
   * Wraps transport.send in a timeout so a stuck SMTP can't hang the request.
   * NEVER throws — same invariant as sendEmail.
   */
  sendTestEmail(input: SendEmailInput): Promise<SendTestEmailResult>;
  isEmailConfigured(): boolean;
  /** Reports which transport is active so the status surface can render correctly. */
  getTransportKind(): EmailTransportKind;
  close(): Promise<void>;
}

export interface CreateEmailServiceDeps {
  audit: ReturnType<typeof createAuditService>;
  /**
   * Optional injected transport for tests. Production path constructs
   * the nodemailer pool from `config.smtp` when SMTP_HOST + SMTP_PORT +
   * SMTP_FROM are all set; otherwise installs a no-op transport that
   * the configured-check guards against ever being invoked.
   */
  transport?: EmailTransport;
  /**
   * Optional suppression check. When provided, sendEmail queries this
   * predicate AFTER the config gate and BEFORE idempotency/rate-limit.
   * A true result short-circuits with `{ status: "suppressed" }` and
   * does NOT invoke the transport.
   *
   * Dependency-injected (not a db handle) so the email service stays
   * decoupled from the DB layer in tests and OSS variants.
   */
  checkSuppressed?: (address: string) => Promise<boolean>;
  /**
   * Optional deliverability breaker lookup. When provided and the input
   * carries an organization_id, sendEmail queries this predicate AFTER the
   * suppression check and BEFORE idempotency/rate-limit. A true result
   * short-circuits with `{ status: "tenant_paused" }` and does NOT invoke
   * the transport. Fails open on rejection, same contract as checkSuppressed.
   *
   * Dependency-injected (not a db handle) so the email service stays
   * decoupled from the DB layer in tests and OSS variants.
   */
  checkTenantPaused?: (orgId: string | null) => Promise<boolean>;
  /**
   * Optional send logger. Called AFTER a successful transport send so a
   * later bounce or complaint can be attributed to a tenant. A logging
   * failure must never break a send that already succeeded, so this is
   * always invoked inside its own try/catch.
   *
   * sendTestEmail also calls this, always with organizationId: null (Fix 2):
   * without a row of its own, an admin's Send-test to a bad address would
   * fall back onto whichever real tenant last mailed that address and
   * mis-attribute the bounce to them instead of to nobody.
   */
  logSend?: (input: {
    messageId: string;
    organizationId: string | null;
    address: string;
    isTransactional: boolean;
    /**
     * Optional (unlike organizationId) so pre-Task-6 duck-typed logSend
     * overrides elsewhere in the test suite keep compiling without being
     * touched for a field they don't exercise. Every call site inside this
     * file passes it explicitly regardless.
     */
    notificationId?: string | null;
  }) => Promise<void>;
}

/**
 * Narrowed shape of `config.smtp` once `isSmtpConfigured` returns true.
 * `host`, `port`, `from` are proven set by the predicate; `user`, `pass`
 * remain `string | undefined` because authenticated SMTP is optional —
 * internal relays often accept unauthenticated connections. Mirrors the
 * source-shape (required-key + undefined value) rather than reshaping
 * to optional-key form, so the type-predicate is assignable to
 * `typeof config.smtp` without TS2677.
 */
type ConfiguredSmtp = {
  host: string;
  port: number;
  from: string;
  /** Reply-To / unsubscribe target; optional, so it stays possibly-undefined. */
  contact: string | undefined;
  secure: boolean;
  user: string | undefined;
  pass: string | undefined;
  txFrom: string | undefined;
  notifyFrom: string | undefined;
};

/**
 * Type predicate variant of the configured-check. Inside the narrowed
 * branch TypeScript proves host/port/from are set, eliminating the need
 * for non-null assertions at the createNodemailerTransport call site.
 */
function isSmtpConfigured(smtp: typeof config.smtp): smtp is ConfiguredSmtp {
  return (
    smtp.host !== undefined &&
    smtp.port !== undefined &&
    smtp.from !== undefined
  );
}

export type { EmailSender, EmailEnvelope, DeliveryResult } from "./email-sender";
export type { NodemailerEmailSenderConfig } from "./nodemailer-email-sender";

export function createEmailService(deps: CreateEmailServiceDeps): EmailService {
  const smtp = config.smtp;
  const configured = isSmtpConfigured(smtp);

  // Resend is Cloud-only. The implementation lives in the private ee
  // submodule, so a self-hosted install does not have the code and
  // `resend` is not one of its dependencies.
  //
  // Gated on mode, not merely on the key being absent. Until this ruling the
  // condition was the env var alone, so a self-hoster who set RESEND_API_KEY
  // silently got the Resend transport. Dropping the code without also moving
  // the gate would have turned that into a module-not-found at send time —
  // failing in the recipient's face, after a review link had been shared.
  const resendUsable =
    config.mode === "cloud" && Boolean(config.resendApiKey) && Boolean(smtp.from);

  if (config.mode !== "cloud" && config.resendApiKey) {
    console.warn(
      "[email] RESEND_API_KEY is set but this is a standalone install — Resend is a Cloud-only transport and the key is ignored. " +
        "Configure SMTP_HOST/SMTP_PORT/SMTP_FROM to send email.",
    );
  } else if (config.resendApiKey && !smtp.from) {
    // A Resend key with no SMTP_FROM is NOT a working configuration: the From
    // header would fall back to a sentinel Resend rejects as an unverified
    // sender, so every send fails at delivery time.
    console.warn(
      "[email] RESEND_API_KEY is set but SMTP_FROM is not — email stays disabled. Set SMTP_FROM to a verified sending address.",
    );
  }

  // Resolve transport: caller-injected wins (tests), then production
  // nodemailer if configured, else no-op stub. The configured-check gate
  // in sendEmail prevents the no-op stub from ever receiving a send call
  // — it exists as a defensive placeholder so close() is always safe.
  let transport: EmailTransport;
  if (deps.transport) {
    transport = deps.transport;
  } else if (resendUsable) {
    transport = createEeResendTransport(config.resendApiKey!);
  } else if (configured) {
    transport = createNodemailerTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      user: smtp.user,
      pass: smtp.pass,
      from: smtp.from,
    });
  } else {
    transport = createNoOpTransport();
  }

  const rateLimiter = createRateLimiter();
  const idempotency = createIdempotencyStore();

  // Treat injected transport as "configured" for gate purposes — tests
  // pass a transport without setting SMTP_* envs, and the whole point
  // of the injection is to exercise the send paths. Production path
  // reads `configured` as before.
  /**
   * Hygiene headers applied to every outbound message.
   *
   * The send-from mailbox is usually no-reply — a Resend sending subdomain
   * only receives bounce feedback — so both the reply path and the
   * unsubscribe mailto point at EMAIL_CONTACT_ADDRESS when the operator set
   * one. Unset keeps the prior behaviour (no Reply-To, unsubscribe addressed
   * to the sender): defaulting it to any Gatewerk-operated address would aim
   * self-hosters' recipients at us instead of at them.
   */
  const buildDefaultHeaders = (
    fromAddr: string,
    input: SendEmailInput,
  ): Record<string, string> => {
    const contact = config.smtp.contact;
    const listUnsub = input.listUnsubscribeUrl
      ? `<${input.listUnsubscribeUrl}>, <mailto:${contact ?? fromAddr}?subject=unsubscribe>`
      : `<mailto:${contact ?? fromAddr}?subject=unsubscribe>`;
    const headers: Record<string, string> = {
      "List-Unsubscribe": listUnsub,
      "Auto-Submitted": "auto-generated",
      ...(contact ? { "Reply-To": contact } : {}),
    };
    if (input.listUnsubscribeUrl) {
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }
    return headers;
  };

  const isConfigured = (): boolean => Boolean(deps.transport) || resendUsable || configured;

  // Injected transports report as "smtp" so tests handing in a stub exercise
  // the OSS-tier status path. Otherwise: Resend wins over SMTP when both are
  // set; precedence pinned by the call ordering below.
  const transportKind = (): EmailTransportKind => {
    if (deps.transport) return "smtp";
    if (resendUsable) return "resend";
    if (configured) return "smtp";
    return "none";
  };

  return {
    isEmailConfigured: isConfigured,
    getTransportKind: transportKind,

    async sendEmail(input) {
      // Normalize `to` at function entry: trim + lowercase so case variants
      // can't bypass per-email rate limits or recipient-scoped idempotency
      // keys, then strip CRLF defensively. CRLF in the to-address is treated
      // as a header-injection attempt and rejected outright (sanitizing
      // would hide the attack from audit_log).
      if (/[\r\n]/.test(input.to)) {
        await safeAudit(() =>
          deps.audit.log({
            action: "email.send_failed",
            actor: "system:email",
            resource_type: "email",
            // Truncate the offending value so audit_log is not used as a
            // mirror to log arbitrary attacker-controlled bytes.
            details: {
              to: input.to.slice(0, 64),
              error: "header_injection_detected",
            },
          }),
        );
        return { status: "failed", error: "header_injection_detected" };
      }
      const to = input.to.trim().toLowerCase();
      // Subjects are MIME-encoded by the SMTP layer; folding CRLF into
      // a single space is benign and keeps any caller-side templating bug
      // from breaking header structure.
      const subject = input.subject.replace(/[\r\n]+/g, " ");
      const { text, html, idempotencyKey, sourceIp } = input;

      // Branch 1: SMTP not configured → graceful-degrade.
      if (!isConfigured()) {
        await safeAudit(() =>
          deps.audit.log({
            action: "email.send_skipped_no_config",
            actor: "system:email",
            resource_type: "email",
            details: { to, subject },
          }),
        );
        return { status: "skipped_no_config" };
      }

      // Branch 1.5: suppression check. Runs after the config gate (no point
      // querying the suppression list when email is disabled) and before
      // idempotency dedup (a suppressed address must not consume a dedup slot
      // that would prevent a future re-send if the suppression is lifted).
      //
      // FAIL OPEN: this call sits OUTSIDE Branch 4's try-catch, so a rejection
      // from checkSuppressed (e.g. a transient DB hiccup) would otherwise
      // escape sendEmail and break the documented NEVER-throws invariant —
      // surfacing as an unhandled 500 to the OTP caller and able to crash the
      // daily-digest loop. We wrap it in its own try-catch and treat a check
      // failure as "not suppressed": a suppression-check outage must never
      // block legitimate mail. Worst case is one email to a possibly-suppressed
      // address, which is vastly preferable to a total email outage.
      if (deps.checkSuppressed) {
        let suppressed = false;
        try {
          suppressed = await deps.checkSuppressed(to);
        } catch (err) {
          console.error(
            "[email] suppression check failed; failing open (treating as not suppressed)",
            err,
          );
        }
        if (suppressed) {
          return { status: "suppressed" };
        }
      }

      // Branch 1.75: deliverability breaker. Runs after suppression (same
      // rationale: no point checking a paused tenant's mail budget when the
      // address itself is already suppressed) and before idempotency dedup,
      // for the same reason as the suppression gate: a paused send must not
      // consume a dedup slot that would block a future re-send once the
      // tenant resumes.
      //
      // Gated on organization_id being present at all (not just truthy) so
      // an omitted org is NEVER checked, matching the "unattributed mail is
      // never gated" invariant. An explicit `null` is checked and always
      // resolves to not-paused (isTenantPaused's own contract), so this
      // still reads as a no-op for unattributed callers that pass null.
      //
      // FAIL OPEN: mirrors checkSuppressed exactly. A pause-lookup outage
      // must never silently stop a tenant's mail — worst case is one email
      // sent to a tenant that should have been paused, which is vastly
      // preferable to sendEmail's NEVER-throws invariant being broken or an
      // unrelated DB blip taking down all outbound mail.
      if (deps.checkTenantPaused && input.organization_id !== undefined) {
        let paused = false;
        try {
          paused = await deps.checkTenantPaused(input.organization_id);
        } catch (err) {
          console.error(
            "[email] pause lookup failed; failing open (sending)",
            err,
          );
        }
        if (paused) {
          // No dedicated audit action here, mirroring the suppressed branch
          // immediately above: this branch fires on every gated send while a
          // tenant stays paused, which would be thousands of audit rows for
          // one ongoing decision. The pause itself is audited once, when the
          // breaker fires (email.tenant_paused, jobs/email-pause-evaluator.ts),
          // and the resume is audited once too (email.tenant_resumed, Task 6's
          // admin route) — that is where this event's audit trail belongs.
          return { status: "tenant_paused" };
        }
      }

      // Branch 2: idempotency dedup. Check BEFORE rate limit so a legitimate
      // double-submit doesn't burn the recipient's per-email budget. Dedup
      // key is recipient-scoped (composite "${to}:${idempotencyKey}") so a
      // form-mount nonce reused across recipients (e.g. router replay,
      // attacker probing) does not return alice's messageId for bob's send.
      const dedupKey =
        idempotencyKey !== undefined ? `${to}:${idempotencyKey}` : undefined;
      if (dedupKey !== undefined) {
        const prior = idempotency.get(dedupKey);
        if (prior !== undefined) {
          await safeAudit(() =>
            deps.audit.log({
              action: "email.send_deduped",
              actor: "system:email",
              resource_type: "email",
              details: { to, subject, idempotency_key: idempotencyKey },
            }),
          );
          return { status: "deduped", messageId: prior };
        }
      }

      // Branch 3a: per-email rate limit. Checked before per-IP because
      // mailbox-protection is the higher-stakes axis (a victim mailbox
      // can be flooded by one IP across many spoofed sources).
      if (!rateLimiter.check(to, "per_email")) {
        await safeAudit(() =>
          deps.audit.log({
            action: "email.rate_limited",
            actor: "system:email",
            resource_type: "email",
            details: { to, reason: "per_email" },
          }),
        );
        return { status: "rate_limited", reason: "per_email" };
      }

      // Branch 3b: per-IP rate limit (when sourceIp is supplied).
      if (sourceIp !== undefined && !rateLimiter.check(sourceIp, "per_ip")) {
        await safeAudit(() =>
          deps.audit.log({
            action: "email.rate_limited",
            actor: "system:email",
            resource_type: "email",
            details: { source_ip: sourceIp, reason: "per_ip" },
          }),
        );
        return { status: "rate_limited", reason: "per_ip" };
      }

      // Branch 4: send. Try-catch wraps transport because SMTP errors
      // (transient network, auth failure, recipient rejected) must NOT
      // bubble — we want callers to handle SendEmailResult, not exceptions.
      //
      // Hygiene headers per RFC 8058 (List-Unsubscribe, Gmail Feb-2024
      // sender policy applies even to transactional) and RFC 3834
      // (Auto-Submitted: auto-generated, identifies the message as
      // machine-originated so recipient autoresponders don't loop).
      // Set at the service layer so policy lives next to the audit
      // events; transport stays a thin SMTP shim.
      //
      // `from` is derived per-call based on the stream routing flag:
      //   - is_transactional === false → notifyFrom (digest/dunning stream)
      //   - is_transactional === true or undefined → txFrom (OTP/reset/verify)
      // Both fall back to smtp.from then to the local sentinel so OSS
      // operators with a single address see no behavioural change.
      const fromAddr =
        input.is_transactional === false
          ? (smtp.notifyFrom ?? smtp.from ?? "noreply@gatewerk.local")
          : (smtp.txFrom ?? smtp.from ?? "noreply@gatewerk.local");
      const defaultHeaders = buildDefaultHeaders(fromAddr, input);
      try {
        const { messageId } = await transport.send({
          to,
          subject,
          text,
          html,
          from: fromAddr,
          headers: defaultHeaders,
        });

        // Record rate-limit hits AFTER successful send. Failed sends do
        // not consume budget — otherwise an SMTP outage would burn caps
        // for legitimate retries once SMTP recovers.
        rateLimiter.record(to, "per_email");
        if (sourceIp !== undefined) {
          rateLimiter.record(sourceIp, "per_ip");
        }

        if (dedupKey !== undefined) {
          idempotency.set(dedupKey, messageId);
        }

        // Deliverability attribution log. Runs AFTER the send already
        // succeeded, so a logging failure here must never turn a delivered
        // email into a reported failure — caught and logged, not propagated.
        if (deps.logSend) {
          try {
            await deps.logSend({
              messageId,
              organizationId: input.organization_id ?? null,
              address: to,
              isTransactional: input.is_transactional !== false,
              notificationId: input.notification_id ?? null,
            });
          } catch (err) {
            console.error(
              "[email] send log failed; send already succeeded",
              err,
            );
          }
        }

        await safeAudit(() =>
          deps.audit.log({
            action: "email.send_succeeded",
            actor: "system:email",
            resource_type: "email",
            details: { to, subject, message_id: messageId },
          }),
        );
        return { status: "sent", messageId };
      } catch (err) {
        // Capture the SMTP error message FIRST into a local — a subsequent
        // audit-emit failure must not replace `error` with audit's error
        // message in the returned result. safeAudit also catches, but the
        // double-belt is intentional: the failure path's contract is
        // "return the underlying SMTP failure verbatim."
        const error = err instanceof Error ? err.message : String(err);
        await safeAudit(() =>
          deps.audit.log({
            action: "email.send_failed",
            actor: "system:email",
            resource_type: "email",
            details: { to, subject, error },
          }),
        );
        return { status: "failed", error };
      }
    },

    async sendTestEmail(input) {
      // Mirror sendEmail's CRLF guard. The to-validation is the same security
      // contract regardless of test/production path.
      if (/[\r\n]/.test(input.to)) {
        await safeAudit(() =>
          deps.audit.log({
            action: "email.test_failed",
            actor: "system:email",
            resource_type: "email",
            details: { to: input.to.slice(0, 64), error: "header_injection_detected" },
          }),
        );
        return { status: "failed", error: "header_injection_detected" };
      }
      const to = input.to.trim().toLowerCase();
      const subject = input.subject.replace(/[\r\n]+/g, " ");
      const { text, html } = input;

      if (!isConfigured()) {
        await safeAudit(() =>
          deps.audit.log({
            action: "email.test_skipped_no_config",
            actor: "system:email",
            resource_type: "email",
            details: { to, subject },
          }),
        );
        return { status: "skipped_no_config" };
      }

      const fromAddr = smtp.from ?? "noreply@gatewerk.local";
      const defaultHeaders = buildDefaultHeaders(fromAddr, input);
      try {
        const sendPromise = transport.send({
          to, subject, text, html, from: fromAddr, headers: defaultHeaders,
        });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("transport_timeout")), SEND_TEST_TIMEOUT_MS),
        );
        const { messageId } = await Promise.race([sendPromise, timeoutPromise]);

        // Log with organizationId: null (Fix 2). A test send otherwise has no
        // row of its own, so a bounce to the same address falls back to
        // whichever tenant last mailed it (send-log.ts's address fallback)
        // and charges an admin's diagnostic send to an innocent tenant. A
        // null-organization row gives the fallback something of its own to
        // match, so the bounce attributes to nobody instead. Same try/catch
        // discipline as sendEmail's logSend call: this runs AFTER the send
        // already succeeded, so a logging failure here must never turn a
        // delivered test email into a reported failure.
        if (deps.logSend) {
          try {
            await deps.logSend({
              messageId,
              organizationId: null,
              address: to,
              isTransactional: true,
              notificationId: null,
            });
          } catch (err) {
            console.error(
              "[email] test send log failed; send already succeeded",
              err,
            );
          }
        }

        await safeAudit(() =>
          deps.audit.log({
            action: "email.test_sent",
            actor: "system:email",
            resource_type: "email",
            details: { to, subject, message_id: messageId },
          }),
        );
        return { status: "sent", messageId };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await safeAudit(() =>
          deps.audit.log({
            action: "email.test_failed",
            actor: "system:email",
            resource_type: "email",
            details: { to, subject, error },
          }),
        );
        return { status: "failed", error };
      }
    },

    async close() {
      await transport.close();
    },
  };
}

/**
 * Factory for the EmailSender adapter interface.
 *
 * Returns (Promise resolving to):
 *   - ResendEmailSender when `mode === "cloud"` AND `RESEND_API_KEY` is set
 *   - NodemailerEmailSender otherwise (OSS default)
 *
 * Async because the Cloud path uses `await import()` with function-indirection
 * (project canonical EE-boundary pattern — see `app.ts:mountEeIfCloud`). The
 * indirection prevents OSS bundles from statically referencing `ee/` modules.
 *
 * The legacy `createEmailService()` is preserved for existing call sites —
 * this factory is additive. New code should prefer `createEmailSender()`.
 */
export async function createEmailSender(opts?: {
  mode?: GatewerkMode;
  resendApiKey?: string;
  smtpConfig?: NodemailerEmailSenderConfig;
  db?: AppDb;
}): Promise<EmailSender> {
  const mode = opts?.mode ?? config.mode;
  const resendApiKey = opts?.resendApiKey ?? config.resendApiKey;

  if (mode === "cloud" && resendApiKey) {
    // Function-indirection prevents bundler from following this statically.
    // Required for OSS bundle isolation; see app.ts:mountEeIfCloud for the
    // canonical pattern. Inline object type avoids a static `typeof import()`
    // reference that would fail tsc under the OSS tsconfig (which excludes ee/).
    const eeSpecifier = (): string => new URL("../../../../../ee/api/adapters/resend-email-sender.js", import.meta.url).href;
    const mod = (await import(eeSpecifier())) as {
      ResendEmailSender: new (apiKey: string) => EmailSender;
    };
    return new mod.ResendEmailSender(resendApiKey);
  }

  const smtpConfig: NodemailerEmailSenderConfig = opts?.smtpConfig ?? {
    host: config.smtp.host ?? "localhost",
    port: config.smtp.port ?? 25,
    secure: config.smtp.secure,
    user: config.smtp.user,
    pass: config.smtp.pass,
    from: config.smtp.from ?? "noreply@gatewerk.local",
  };

  return new NodemailerEmailSender(smtpConfig, opts?.db);
}

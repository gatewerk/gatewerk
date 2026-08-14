import React from "react";
import { render, toPlainText } from "@react-email/render";
import type { FC } from "react";

/** Rendered email contents. Matches EmailService.sendEmail({ subject, text, html }). */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

// Typed error so catchers (daily-digest per-batch try/catch, account fire-and-forget,
// login-notification try/catch) can distinguish a structurally-empty render from
// other render failures without string-matching on Error.message.
export class EmailRenderEmptyError extends Error {
  readonly templateName: string;
  constructor(templateName: string) {
    super(`renderEmail produced an empty body (template: ${templateName})`);
    this.name = "EmailRenderEmptyError";
    this.templateName = templateName;
  }
}

/**
 * A React-Email template component augmented with a static `subject` method.
 * The subject method receives the same props as the component, so subject copy
 * co-locates with body copy.
 */
export type EmailTemplate<TProps> = FC<TProps> & {
  subject: (props: TProps) => string;
};

/**
 * Render a React-Email template to { subject, text, html }.
 * `html` is the full email HTML; `text` is the plain-text fallback derived via
 * toPlainText(html) (single render pass); `subject` comes from the template's
 * static `subject(props)` method. Async because render() is async.
 */
export async function renderEmail<TProps>(
  Template: EmailTemplate<TProps>,
  props: TProps,
): Promise<RenderedEmail> {
  // React.createElement avoids the TypeScript limitation where spreading a
  // generic TProps into JSX syntax is rejected ("could be unrelated to {}").
  const el = React.createElement(
    Template as FC<Record<string, unknown>>,
    props as Record<string, unknown>,
  );
  const html = await render(el, { pretty: false });
  // toPlainText is the non-deprecated path in @react-email/render >=2.x;
  // synchronous, derives text from the already-rendered HTML (single render pass).
  const text = toPlainText(html);
  // Loud failure at the render boundary beats silently delivering a blank
  // email body. The throw propagates to the caller's error handling (the
  // daily-digest per-batch try/catch, the account fire-and-forget catch, the
  // login-notification try/catch).
  if (!html || !text) {
    const name = Template.displayName || Template.name || "unknown";
    throw new EmailRenderEmptyError(name);
  }
  return { subject: Template.subject(props), html, text };
}

// OSS email templates. Re-exported here so call sites import `@gatewerk/emails`
// without reaching into source paths. EE (Cloud) templates are intentionally
// NOT re-exported here. They used to sit behind a `./ee` subpath export on this
// package; they now live in the private ee submodule (ee/emails), because a
// subpath export cannot point outside its own package — node rejects any
// exports target containing `..` with ERR_INVALID_PACKAGE_TARGET. Their only
// consumer is ee/api, which reaches them by relative path.
export { OtpCodeEmail } from "./templates/otp-code";
export type { OtpCodeEmailProps } from "./templates/otp-code";
export { EmailVerifyEmail } from "./templates/email-verify";
export type { EmailVerifyEmailProps } from "./templates/email-verify";
export { PasswordResetEmail } from "./templates/password-reset";
export type { PasswordResetEmailProps } from "./templates/password-reset";
export { DailyDigestEmail } from "./templates/daily-digest";
export type { DailyDigestEmailProps } from "./templates/daily-digest";
export { NewIpLoginEmail } from "./templates/new-ip-login";
export type { NewIpLoginEmailProps } from "./templates/new-ip-login";
export { TestEmail } from "./templates/test-email";
export type { TestEmailProps } from "./templates/test-email";
export { YourTurnEmail } from "./templates/your-turn";
export type { YourTurnEmailProps } from "./templates/your-turn";
export { NotificationDigestEmail } from "./templates/notification-digest";
export type { NotificationDigestEmailProps } from "./templates/notification-digest";

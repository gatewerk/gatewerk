import { z } from "zod";

/**
 * Email transport surface — OSS uses nodemailer SMTP, Cloud uses Resend, neither
 * configured falls back to a no-op stub. The status endpoint reflects whichever
 * is active so the admin can tell whether outbound delivery is wired before they
 * find out by way of a recipient never getting an OTP.
 */
export const EMAIL_TRANSPORT_KINDS = ["smtp", "resend", "none"] as const;
export type EmailTransportKind = (typeof EMAIL_TRANSPORT_KINDS)[number];
export const EmailTransportKindSchema = z.enum(EMAIL_TRANSPORT_KINDS);

/**
 * Discriminated by `transport` so impossible states (e.g. transport="smtp" with
 * smtp:null, or transport="none" with configured:true) are unrepresentable. The
 * UI branches on `transport` exhaustively; future variants force a compile-time
 * update at every consumer.
 */
export const EmailStatusResponseSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("smtp"),
    configured: z.literal(true),
    smtp: z.object({
      host: z.string(),
      port: z.number().int().positive(),
      from: z.string(),
      /** True when SMTP_USER+SMTP_PASS are both set. Boolean only, secret never returned. */
      auth: z.boolean(),
      secure: z.boolean(),
    }),
    /** May be true alongside transport=smtp if both are configured (SMTP wins). */
    resend_configured: z.boolean(),
  }),
  z.object({
    transport: z.literal("resend"),
    configured: z.literal(true),
    resend_configured: z.literal(true),
  }),
  z.object({
    transport: z.literal("none"),
    configured: z.literal(false),
    resend_configured: z.literal(false),
  }),
]);

export const EmailTestBodySchema = z.object({
  to: z.email(),
});

/** Discriminated by `status` so the UI renders branch-specific copy
 *  (success message id, no-config hint, raw transport error). */
export const EmailTestResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("sent"),
    message_id: z.string(),
    latency_ms: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("skipped_no_config"),
    latency_ms: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    latency_ms: z.number().int().nonnegative(),
  }),
]);

export type EmailStatusResponse = z.infer<typeof EmailStatusResponseSchema>;
export type EmailTestBody = z.infer<typeof EmailTestBodySchema>;
export type EmailTestResponse = z.infer<typeof EmailTestResponseSchema>;

import { and, eq, gt, inArray } from "drizzle-orm";
import { auditLog } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import type { EmailService } from "../services/email";
import { renderEmail, NewIpLoginEmail } from "@gatewerk/emails";
import { config } from "../config";

export async function notifyNewIpLogin(
  db: AppDb,
  emailService: EmailService,
  reviewer: { id: string; email: string; login_notifications?: boolean | null },
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<void> {
  if (!reviewer.login_notifications || !ip) return;

  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentLogins = await db
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actor, reviewer.id),
          // Passkey logins write "passkey.login_success", not
          // "auth.login_success" — matching only the latter meant a
          // passkey-only user's own past logins never counted as "known",
          // so every passkey sign-in looked like a new device.
          inArray(auditLog.action, ["auth.login_success", "passkey.login_success"]),
          gt(auditLog.created_at, thirtyDaysAgo),
        ),
      );

    const knownIps = new Set(
      recentLogins.map(r => (r.details as any)?.ip).filter(Boolean),
    );

    if (!knownIps.has(ip)) {
      const rendered = await renderEmail(NewIpLoginEmail, {
        ip,
        userAgent,
        detectedAt: new Date().toISOString(),
        logoUrl: config.emailLogoUrl,
      });
      // Deliberately does NOT pass organization_id here. Doing so would opt
      // this send into the per-tenant deliverability breaker (Stage 5a,
      // apps/api/src/services/email/index.ts), which can silently drop mail
      // for a paused tenant. Login mail must keep reaching a user whose
      // organization is paused, since blocking it would lock them out of
      // the product entirely, a worse outcome than the bounces the breaker
      // exists to prevent. See notification-email-handler.ts /
      // notification-digest-handler.ts for the mail that IS meant to opt in.
      await emailService.sendEmail({ to: reviewer.email, ...rendered });
    }
  } catch (err) {
    // Fire-and-forget — never block login on notification failure. Log so a
    // render/send failure is observable instead of vanishing silently.
    console.warn("[login-notifications] new-IP email failed", {
      errorId: "LOGIN_NOTIFICATION_FAILED",
      error: err,
    });
  }
}

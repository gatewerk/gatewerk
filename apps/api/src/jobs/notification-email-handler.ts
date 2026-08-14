import { eq } from 'drizzle-orm'
import { notifications, notificationPreferences } from '@gatewerk/db'
import { DEFAULT_NOTIFICATION_PREFS, type NotificationCategory } from '@gatewerk/shared'
import type { AppDb } from '@gatewerk/db'
import { renderYourTurnEmail } from '../services/jobs/your-turn-email'
import { resolveTenantOrgId } from './notification-slack-handler'
import type { SendEmailInput, SendEmailResult } from '../services/email/index'

export interface NotificationEmailJob {
  notificationId: string
  email: string
}

interface Deps {
  db: AppDb
  // Real SendEmailInput/SendEmailResult, not (i: any) — I-1: an untyped dep
  // let `notification_id` (the one field that makes Task 6's bounce
  // correlation work) be renamed, typo'd, or dropped with a clean typecheck.
  email: { sendEmail: (i: SendEmailInput) => Promise<SendEmailResult> }
}

// `null` means no send was attempted (notification gone, already read in-app,
// or suppressed by preferences) — distinct from a send that was attempted and
// reported an outcome.
export async function handleNotificationEmail(
  deps: Deps,
  job: NotificationEmailJob,
): Promise<SendEmailResult | null> {
  const [n] = await deps.db
    .select()
    .from(notifications)
    .where(eq(notifications.id, job.notificationId))
    .limit(1)
  if (!n || n.read_at) return null // gone or already seen in-app

  const [pref] = await deps.db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.reviewer_id, n.reviewer_id))
    .limit(1)
  const prefs = pref?.prefs ?? DEFAULT_NOTIFICATION_PREFS
  const cat = n.category as NotificationCategory
  if (!prefs.channels[cat]?.email) return null // email disabled for this category

  // Opt this send into the per-tenant deliverability breaker (Stage 5a).
  // Notification mail is exactly the volume that can damage a sending
  // domain, so it opts in. This is deliberately NOT mirrored onto
  // authentication or account mail (routes/token-reviews-email-otp.ts,
  // lib/login-notifications.ts, routes/account.ts) — those must keep
  // working for a paused tenant, since blocking OTP or login mail would
  // lock users out of the product, and reviewers out of reviews entirely,
  // which is worse than the bounces the breaker exists to prevent.
  //
  // An ambiguous tenant must never drop the notification: it just leaves
  // organization_id null, so the breaker simply does not apply to this send.
  const tenant = await resolveTenantOrgId(deps.db, { reviewer_id: n.reviewer_id, review_id: n.review_id })
  const organization_id = tenant.ok ? tenant.orgId : null

  const rendered = await renderYourTurnEmail(n.title, n.review_id)
  // Return the outcome instead of discarding it. sendEmail never throws — it
  // reports every case through this union — so a swallowed result meant a
  // broken SMTP config produced no error anywhere: the worker's try/catch
  // could never fire because nothing was ever thrown. The caller decides what
  // to do with `failed`.
  return deps.email.sendEmail({
    to: job.email,
    ...rendered,
    is_transactional: true,
    organization_id,
    notification_id: job.notificationId,
  })
}

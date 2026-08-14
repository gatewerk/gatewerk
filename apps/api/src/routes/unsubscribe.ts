import { Router } from 'express'
import { eq } from 'drizzle-orm'
import { notificationPreferences } from '@gatewerk/db'
import { DEFAULT_NOTIFICATION_PREFS } from '@gatewerk/shared'
import type { AppDb } from '@gatewerk/db'
import { verifyEmailToken } from '../lib/email-tokens'
import { config } from '../config'
import type { AuditService } from '../services/audit'

async function disableDigest(db: AppDb, reviewerId: string): Promise<void> {
  const [row] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.reviewer_id, reviewerId))
    .limit(1)
  const prefs = row?.prefs ?? DEFAULT_NOTIFICATION_PREFS
  const next = { ...prefs, digest: { ...prefs.digest, enabled: false } }
  await db
    .insert(notificationPreferences)
    .values({ reviewer_id: reviewerId, prefs: next, updated_at: new Date() })
    .onConflictDoUpdate({
      target: notificationPreferences.reviewer_id,
      set: { prefs: next, updated_at: new Date() },
    })
}

/**
 * Verify the token, flip the preference, and record it.
 *
 * The audit write lives here rather than in the two handlers because this is the
 * single mutation path: both the RFC 8058 one-click POST and the human GET reach
 * the preference change through this function, and the POST is the one most mail
 * clients actually call. Auditing only the GET would have left the busier path
 * silent.
 *
 * Tier 3 BEST_EFFORT (services/AUDIT-WRITE-CONTRACT.md). An unsubscribe must
 * never fail because audit_log is unavailable — refusing to honour a
 * one-click unsubscribe is a deliverability and compliance problem far worse than
 * a missing ledger row, and notification_preferences is durable and readable.
 *
 * The route is unauthenticated and its only credential is the signed token, so
 * the RAW TOKEN IS NEVER RECORDED: it is a live bearer credential for this
 * reviewer's preferences, and audit_log is admin-readable. Only the subject the
 * token resolved to is written.
 */
async function flip(
  db: AppDb,
  token: string,
  auditService?: AuditService,
  via?: 'one_click_post' | 'link_get',
): Promise<boolean> {
  const payload = verifyEmailToken(token, 'digest_unsubscribe')
  if (!payload?.reviewer_id) return false
  await disableDigest(db, payload.reviewer_id)
  // No project_id: notification_preferences is keyed by reviewer_id and is not
  // project-scoped, so there is no tenant partition this row belongs to.
  auditService?.logBestEffort(
    {
      action: 'notification.unsubscribed',
      actor: `reviewer:${payload.reviewer_id}`,
      resource_type: 'notification_preferences',
      resource_id: payload.reviewer_id,
      details: { subject: 'digest', enabled: false, via: via ?? 'unknown' },
    },
    'an unsubscribe must never fail on an audit outage, and the preference row is durable',
  )
  return true
}

export function createUnsubscribeRoutes(db: AppDb, auditService?: AuditService): Router {
  const r = Router()

  // RFC 8058 one-click machine POST (body may be application/x-www-form-urlencoded)
  r.post('/:token', async (req, res) => {
    const ok = await flip(db, req.params.token, auditService, 'one_click_post').catch(() => false)
    res.status(ok ? 200 : 400).json({ ok })
  })

  // Human GET — verify + flip + redirect to confirmation page
  r.get('/:token', async (req, res) => {
    const ok = await flip(db, req.params.token, auditService, 'link_get').catch(() => false)
    if (!ok) {
      return res.status(400).send('Invalid or expired unsubscribe link.')
    }
    // `done=1` tells the landing page a flip actually happened. Without it the
    // page shows a neutral explainer: a direct visit to /unsubscribe must not
    // claim "you are unsubscribed" when nothing was.
    // nosemgrep: javascript.express.web.tainted-redirect-express.tainted-redirect-express
    res.redirect(302, `${config.uiOrigin}/unsubscribe?done=1`)
  })

  return r
}

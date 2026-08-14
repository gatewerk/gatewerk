import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../app'
import { createTestDb, seedReviewer } from '../__tests__/helpers/test-db'
import {
  notificationPreferences,
  notificationSuppressions,
} from '@gatewerk/db/src/schema/index'
import { DEFAULT_NOTIFICATION_PREFS } from '@gatewerk/shared'
import { generateEmailToken } from '../lib/email-tokens'

const TTL_MS = 60 * 60 * 1000 // 1 hour

describe('unsubscribe routes', () => {
  let db: any
  let app: any

  beforeEach(async () => {
    const testDb = await createTestDb()
    db = testDb.db
    app = createApp({ db })
  })

  async function seedReviewerWithDigestEnabled(email: string) {
    const { reviewer } = await seedReviewer(db, app, { email })
    // Upsert prefs with digest.enabled = true
    const prefs = { ...DEFAULT_NOTIFICATION_PREFS, digest: { ...DEFAULT_NOTIFICATION_PREFS.digest, enabled: true } }
    await db
      .insert(notificationPreferences)
      .values({ reviewer_id: reviewer.id, prefs, updated_at: new Date() })
      .onConflictDoUpdate({
        target: notificationPreferences.reviewer_id,
        set: { prefs, updated_at: new Date() },
      })
    return reviewer
  }

  async function getPrefs(reviewerId: string) {
    const [row] = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.reviewer_id, reviewerId))
      .limit(1)
    return row?.prefs ?? DEFAULT_NOTIFICATION_PREFS
  }

  async function isSuppressed(email: string): Promise<boolean> {
    const [row] = await db
      .select()
      .from(notificationSuppressions)
      .where(eq(notificationSuppressions.address, email))
      .limit(1)
    return !!row
  }

  it('POST valid token → 200 and flips digest.enabled to false', async () => {
    const reviewer = await seedReviewerWithDigestEnabled('alice@test.com')
    const token = generateEmailToken(
      { reviewer_id: reviewer.id, email: reviewer.email, purpose: 'digest_unsubscribe' },
      TTL_MS,
    )

    const res = await request(app).post(`/api/v1/unsub/${token}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const prefs = await getPrefs(reviewer.id)
    expect(prefs.digest.enabled).toBe(false)
  })

  it('POST tampered token → 400 and prefs unchanged', async () => {
    const reviewer = await seedReviewerWithDigestEnabled('bob@test.com')
    const token = generateEmailToken(
      { reviewer_id: reviewer.id, email: reviewer.email, purpose: 'digest_unsubscribe' },
      TTL_MS,
    )
    const tampered = token.slice(0, -4) + 'XXXX'

    const res = await request(app).post(`/api/v1/unsub/${tampered}`)
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)

    const prefs = await getPrefs(reviewer.id)
    expect(prefs.digest.enabled).toBe(true)
  })

  it('GET valid token → 302 to /unsubscribe?done=1 (the landing page only confirms with the marker)', async () => {
    const reviewer = await seedReviewerWithDigestEnabled('carol@test.com')
    const token = generateEmailToken(
      { reviewer_id: reviewer.id, email: reviewer.email, purpose: 'digest_unsubscribe' },
      TTL_MS,
    )

    const res = await request(app).get(`/api/v1/unsub/${token}`)
    expect(res.status).toBe(302)
    expect(res.headers.location).toContain('/unsubscribe?done=1')
  })

  it('POST idempotent — second POST still 200 and still disabled', async () => {
    const reviewer = await seedReviewerWithDigestEnabled('dave@test.com')
    const token = generateEmailToken(
      { reviewer_id: reviewer.id, email: reviewer.email, purpose: 'digest_unsubscribe' },
      TTL_MS,
    )

    await request(app).post(`/api/v1/unsub/${token}`).expect(200)
    const res2 = await request(app).post(`/api/v1/unsub/${token}`)
    expect(res2.status).toBe(200)
    expect(res2.body.ok).toBe(true)

    const prefs = await getPrefs(reviewer.id)
    expect(prefs.digest.enabled).toBe(false)
  })

  it('unsubscribing does NOT add the reviewer to notification_suppressions', async () => {
    const reviewer = await seedReviewerWithDigestEnabled('eve@test.com')
    const token = generateEmailToken(
      { reviewer_id: reviewer.id, email: reviewer.email, purpose: 'digest_unsubscribe' },
      TTL_MS,
    )

    await request(app).post(`/api/v1/unsub/${token}`).expect(200)

    const suppressed = await isSuppressed(reviewer.email)
    expect(suppressed).toBe(false)
  })

  it('GET invalid token → 400 with plain error text', async () => {
    const res = await request(app).get('/api/v1/unsub/not-a-valid-token')
    expect(res.status).toBe(400)
    expect(res.text).toContain('Invalid or expired')
  })

  it('POST wrong-purpose token → 400', async () => {
    const reviewer = await seedReviewerWithDigestEnabled('frank@test.com')
    const token = generateEmailToken(
      { reviewer_id: reviewer.id, email: reviewer.email, purpose: 'verify-email' },
      TTL_MS,
    )

    const res = await request(app).post(`/api/v1/unsub/${token}`)
    expect(res.status).toBe(400)
  })
})

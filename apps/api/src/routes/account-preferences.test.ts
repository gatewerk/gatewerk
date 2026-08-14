import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../app'
import { createTestDb, seedReviewer } from '../__tests__/helpers/test-db'
import { DEFAULT_NOTIFICATION_PREFS } from '@gatewerk/shared'

describe('GET/PUT /auth/preferences', () => {
  let db: any
  let app: any

  beforeEach(async () => {
    const testDb = await createTestDb()
    db = testDb.db
    app = createApp({ db })
  })

  it('returns defaults, then persists an update', async () => {
    const { sessionToken } = await seedReviewer(db, app, {
      email: 'prefs-user@test.com',
      role: 'reviewer',
    })

    // GET /preferences before any PUT — should return DEFAULT_NOTIFICATION_PREFS
    const seed = await request(app)
      .get('/api/v1/auth/preferences')
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(200)

    expect(seed.body.notifications).toEqual(DEFAULT_NOTIFICATION_PREFS)
    expect(typeof seed.body.login_notifications).toBe('boolean')

    // PUT with a modified notifications object
    const next = { ...DEFAULT_NOTIFICATION_PREFS }
    next.channels = { ...next.channels, updates: { email: true, slack: false } }
    await request(app)
      .put('/api/v1/auth/preferences')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ notifications: next })
      .expect(200)

    // GET again — should reflect the persisted update
    const after = await request(app)
      .get('/api/v1/auth/preferences')
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(200)

    expect(after.body.notifications.channels.updates.email).toBe(true)
  })

  it('rejects a malformed notifications body with 422', async () => {
    const { sessionToken } = await seedReviewer(db, app, {
      email: 'prefs-malformed@test.com',
      role: 'reviewer',
    })

    // channels sent as a string + missing required digest field
    const res = await request(app)
      .put('/api/v1/auth/preferences')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ notifications: { channels: 'nope', timezone: null, quiet_hours: null } })

    expect(res.status).toBe(422)
  })
})

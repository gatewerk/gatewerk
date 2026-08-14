import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../app'
import { createTestDb, seedTestProject, seedReviewer } from '../__tests__/helpers/test-db'
import { reviews, notifications } from '@gatewerk/db/src/schema/index'
import { eq } from 'drizzle-orm'
import { generateId } from '@gatewerk/shared'
import { PersonalNotifier } from '../services/personal-notifier'

describe('notifications routes', () => {
  let db: any
  let app: any
  let projectId: string

  beforeEach(async () => {
    const testDb = await createTestDb()
    db = testDb.db
    app = createApp({ db })
    const { project } = await seedTestProject(db)
    projectId = project.id
  })

  it('lists notifications and unread count, then marks seen', async () => {
    const { reviewer, sessionToken } = await seedReviewer(db, app, {
      email: 'alice@test.com',
      role: 'reviewer',
    })

    // Insert a review assigned to alice
    const [rev] = await db
      .insert(reviews)
      .values({
        id: generateId('review'),
        project_id: projectId,
        template_slug: 'test-template',
        payload: { subject: 'test' },
        assignee: reviewer.id,
        status: 'pending',
      })
      .returning()

    // Create notification via PersonalNotifier
    await new PersonalNotifier(db).handleEvent('review.created', { review_id: rev.id })

    const agent = request(app)

    // List notifications — should have 1
    const list = await agent
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(200)
    expect(list.body.notifications).toHaveLength(1)
    expect(list.body.notifications[0].reviewer_id).toBe(reviewer.id)
    // Regression guard: API must emit snake_case keys, not camelCase
    expect(list.body.notifications[0]).toHaveProperty('review_id')
    expect(list.body.notifications[0]).toHaveProperty('read_at')

    // Unread count — should be 1
    const before = await agent
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(200)
    expect(before.body.count).toBe(1)

    // Mark seen
    await agent
      .post(`/api/v1/reviews/${rev.id}/seen`)
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(204)

    // Unread count — should now be 0
    const after = await agent
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(200)
    expect(after.body.count).toBe(0)
  })

  it('does not return another reviewer notifications to the current reviewer', async () => {
    const { reviewer: alice, sessionToken: aliceToken } = await seedReviewer(db, app, {
      email: 'alice2@test.com',
      role: 'reviewer',
    })
    const { reviewer: bob } = await seedReviewer(db, app, {
      email: 'bob@test.com',
      role: 'reviewer',
    })

    // Review assigned to bob
    const [rev] = await db
      .insert(reviews)
      .values({
        id: generateId('review'),
        project_id: projectId,
        template_slug: 'test-template',
        payload: { subject: 'test' },
        assignee: bob.id,
        status: 'pending',
      })
      .returning()

    await new PersonalNotifier(db).handleEvent('review.created', { review_id: rev.id })

    // Alice should see 0 notifications
    const list = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(200)
    expect(list.body.notifications).toHaveLength(0)

    const count = await request(app)
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(200)
    expect(count.body.count).toBe(0)
  })

  it('mark-seen is a no-op for a non-owner (cannot mutate another reviewer rows)', async () => {
    const { sessionToken: aliceToken } = await seedReviewer(db, app, {
      email: 'alice3@test.com',
      role: 'reviewer',
    })
    const { reviewer: bob } = await seedReviewer(db, app, {
      email: 'bob2@test.com',
      role: 'reviewer',
    })

    // Review assigned to bob → notification for bob
    const [rev] = await db
      .insert(reviews)
      .values({
        id: generateId('review'),
        project_id: projectId,
        template_slug: 'test-template',
        payload: { subject: 'test' },
        assignee: bob.id,
        status: 'pending',
      })
      .returning()

    await new PersonalNotifier(db).handleEvent('review.created', { review_id: rev.id })

    // Alice attempts to mark bob's review seen → 204 (no-op)
    await request(app)
      .post(`/api/v1/reviews/${rev.id}/seen`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(204)

    // Bob's notification read_at must still be null
    const [bobNotification] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.reviewer_id, bob.id))
    expect(bobNotification).toBeDefined()
    expect(bobNotification.read_at).toBeNull()
  })
})

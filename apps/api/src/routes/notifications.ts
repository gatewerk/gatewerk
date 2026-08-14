import { Router } from 'express'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { notifications } from '@gatewerk/db'
import type { AppDb } from '@gatewerk/db'
import { sessionAuth } from '../middleware/session-auth'

export function notificationsRouter(db: AppDb): Router {
  const r = Router()

  r.get('/', sessionAuth(db), async (req, res, next) => {
    try {
      const reviewerId = (req as any).reviewer.id
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? ''), 10) || 50, 1), 100)
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.reviewer_id, reviewerId))
        .orderBy(desc(notifications.created_at))
        .limit(limit)
      res.json({ notifications: rows })
    } catch (err) {
      next(err)
    }
  })

  r.get('/unread-count', sessionAuth(db), async (req, res, next) => {
    try {
      const reviewerId = (req as any).reviewer.id
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.reviewer_id, reviewerId), isNull(notifications.read_at)))
      res.json({ count: row?.count ?? 0 })
    } catch (err) {
      next(err)
    }
  })

  return r
}

export function createSeenRoute(db: AppDb): Router {
  const r = Router()

  r.post('/:id/seen', sessionAuth(db), async (req, res, next) => {
    try {
      const reviewerId = (req as any).reviewer.id
      const reviewId = String(req.params.id)
      await db
        .update(notifications)
        .set({ read_at: new Date() })
        .where(
          and(
            eq(notifications.reviewer_id, reviewerId),
            eq(notifications.review_id, reviewId),
            isNull(notifications.read_at),
          ),
        )
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })

  return r
}

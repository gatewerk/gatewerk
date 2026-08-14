import { describe, it, expect } from 'vitest'
import { notifications } from './notifications'

describe('notifications schema', () => {
  it('exposes the expected columns', () => {
    const cols = Object.keys(notifications)
    for (const c of ['id', 'reviewer_id', 'review_id', 'event', 'category', 'title', 'dedup_key', 'read_at', 'created_at']) {
      expect(cols).toContain(c)
    }
  })
})

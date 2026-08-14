import { describe, it, expect } from 'vitest'
import { notificationSuppressions } from './notification-suppressions'
describe('notification_suppressions schema', () => {
  it('has snake_case columns', () => {
    const cols = Object.keys(notificationSuppressions)
    for (const c of ['id', 'address', 'reason', 'metadata', 'created_at']) expect(cols).toContain(c)
  })
})

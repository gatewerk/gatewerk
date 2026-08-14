import { describe, it, expect } from 'vitest'
import { notificationPreferences } from './notification-preferences'
describe('notification_preferences schema', () => {
  it('has reviewer_id PK, prefs, updated_at', () => {
    const cols = Object.keys(notificationPreferences)
    for (const c of ['reviewer_id', 'prefs', 'updated_at']) expect(cols).toContain(c)
  })
})

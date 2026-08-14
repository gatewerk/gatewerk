// packages/shared/src/notifications.test.ts
import { describe, it, expect } from 'vitest'
import {
  categoryForEvent,
  DEFAULT_NOTIFICATION_PREFS,
  quietHoursDelaySeconds,
  categoriesWithEvents,
  NOTIFICATION_CATEGORIES,
  QUIET_HOURS_MAX_DEFERRAL_SECONDS,
} from './notifications'
import { NOTIFICATION_EVENTS } from './index'

describe('categoryForEvent', () => {
  it('maps assignment/urgent to oversight', () => {
    expect(categoryForEvent('review.assigned')).toBe('oversight')
    expect(categoryForEvent('review.urgent')).toBe('oversight')
    expect(categoryForEvent('review.assignment_escalated')).toBe('oversight')
  })
  it('maps result events to my_activity', () => {
    expect(categoryForEvent('review.decided')).toBe('my_activity')
    expect(categoryForEvent('chain.completed')).toBe('my_activity')
  })
  it('returns null for unmapped events', () => {
    expect(categoryForEvent('review.retried')).toBeNull()
  })
  it('maps review.reminder to oversight', () => {
    expect(categoryForEvent('review.reminder')).toBe('oversight')
  })
})

describe('NOTIFICATION_EVENTS', () => {
  it('includes review.reminder', () => {
    expect(NOTIFICATION_EVENTS).toContain('review.reminder')
  })
})

describe('DEFAULT_NOTIFICATION_PREFS', () => {
  it('defaults oversight + my_activity email ON, slack OFF, updates email OFF', () => {
    expect(DEFAULT_NOTIFICATION_PREFS.channels.oversight.email).toBe(true)
    expect(DEFAULT_NOTIFICATION_PREFS.channels.oversight.slack).toBe(false)
    expect(DEFAULT_NOTIFICATION_PREFS.channels.updates.email).toBe(false)
  })
})

const QH = { start: '22:00', end: '07:00' }

function at(iso: string) {
  return new Date(iso)
}

describe('quietHoursDelaySeconds', () => {
  it('returns the base delay when no quiet hours are set', () => {
    expect(
      quietHoursDelaySeconds({
        baseDelaySeconds: 600,
        now: at('2026-07-27T23:00:00Z'),
        quietHours: null,
        timezone: 'UTC',
        isUrgent: false,
      }),
    ).toBe(600)
  })

  it('returns the base delay when the fire time is outside the window', () => {
    // 12:00 UTC + 600s = 12:10, nowhere near 22:00-07:00
    expect(
      quietHoursDelaySeconds({
        baseDelaySeconds: 600,
        now: at('2026-07-27T12:00:00Z'),
        quietHours: QH,
        timezone: 'UTC',
        isUrgent: false,
      }),
    ).toBe(600)
  })

  it('defers to the window edge when the fire time lands inside quiet hours', () => {
    // 23:00 UTC fires inside 22:00-07:00; next 07:00 is 8h later = 28800s
    const d = quietHoursDelaySeconds({
      baseDelaySeconds: 600,
      now: at('2026-07-27T23:00:00Z'),
      quietHours: QH,
      timezone: 'UTC',
      isUrgent: false,
    })
    expect(d).toBe(8 * 3600)
  })

  it('urgent bypasses quiet hours entirely', () => {
    expect(
      quietHoursDelaySeconds({
        baseDelaySeconds: 120,
        now: at('2026-07-27T23:00:00Z'),
        quietHours: QH,
        timezone: 'UTC',
        isUrgent: true,
      }),
    ).toBe(120)
  })

  it('handles a window that does not cross midnight', () => {
    // 13:00-14:00 quiet; firing 13:30 defers to 14:00
    const d = quietHoursDelaySeconds({
      baseDelaySeconds: 0,
      now: at('2026-07-27T13:30:00Z'),
      quietHours: { start: '13:00', end: '14:00' },
      timezone: 'UTC',
      isUrgent: false,
    })
    expect(d).toBe(30 * 60)
  })

  it('respects the user timezone rather than UTC', () => {
    // 20:00 UTC is 23:00 in Europe/Istanbul (UTC+3), inside 22:00-07:00.
    // A UTC-only implementation would see 20:00 and NOT defer, so this test
    // fails against a timezone-blind implementation.
    const d = quietHoursDelaySeconds({
      baseDelaySeconds: 0,
      now: at('2026-07-27T20:00:00Z'),
      quietHours: QH,
      timezone: 'Europe/Istanbul',
      isUrgent: false,
    })
    expect(d).toBeGreaterThan(0)
  })

  it('treats a null timezone as UTC', () => {
    // 23:00 UTC sits inside 22:00-07:00 in UTC itself. A null timezone that
    // resolves to UTC therefore DEFERS to the window edge (07:00, 8h later =
    // 28800s). A null timezone that instead fell back to "unusable, return
    // the base delay unchanged" (the exact failure H-1/F2 named) would
    // return 600. The two behaviours produce DIFFERENT numbers here — unlike
    // the previous version of this test, which used baseDelaySeconds: 0,
    // where both the UTC answer and the fallback answer collapse to 0 and
    // the assertion passes either way. Asserting the UTC value against this
    // scenario is what actually discriminates.
    const d = quietHoursDelaySeconds({
      baseDelaySeconds: 600,
      now: at('2026-07-27T23:00:00Z'),
      quietHours: QH,
      timezone: null,
      isUrgent: false,
    })
    expect(d).toBe(8 * 3600)
  })

  it('falls back to the base delay on an unparseable timezone instead of throwing', () => {
    // Never let a bad stored preference stop a notification.
    expect(
      quietHoursDelaySeconds({
        baseDelaySeconds: 600,
        now: at('2026-07-27T23:00:00Z'),
        quietHours: QH,
        timezone: 'Not/AZone',
        isUrgent: false,
      }),
    ).toBe(600)
  })

  it('caps the deferral at 12 hours for a pathological one minute window', () => {
    // 23:59-23:58 is "quiet" for all but one minute of the day. Uncapped, firing
    // at 00:10 would defer ~23h50m (600s base + 1428 minutes) — uncomfortably
    // close to pg-boss's 24h job expiry. It must clamp to the exported cap.
    const d = quietHoursDelaySeconds({
      baseDelaySeconds: 600,
      now: at('2026-07-27T00:00:00Z'),
      quietHours: { start: '23:59', end: '23:58' },
      timezone: 'UTC',
      isUrgent: false,
    })
    expect(d).toBe(QUIET_HOURS_MAX_DEFERRAL_SECONDS)
  })
})

describe('categoriesWithEvents', () => {
  it('lists only categories that at least one event maps to', () => {
    expect(categoriesWithEvents()).toEqual(['oversight', 'my_activity'])
  })

  it('never lists a category that is not a real category', () => {
    for (const c of categoriesWithEvents()) {
      expect(NOTIFICATION_CATEGORIES).toContain(c)
    }
  })

  it('preserves the declared category order rather than event insertion order', () => {
    const order = categoriesWithEvents()
    const declared = NOTIFICATION_CATEGORIES.filter((c) => order.includes(c))
    expect(order).toEqual([...declared])
  })
})

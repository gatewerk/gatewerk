// packages/shared/src/notifications.ts
export const NOTIFICATION_CATEGORIES = ['oversight', 'my_activity', 'workspace', 'updates'] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

// Per-user delivery channels — DELIBERATELY separate from NOTIFICATION_CHANNEL_TYPES.
export const NOTIFICATION_DELIVERY_CHANNELS = ['in_app', 'email', 'slack'] as const
export type NotificationDeliveryChannel = (typeof NOTIFICATION_DELIVERY_CHANNELS)[number]

const EVENT_CATEGORY: Record<string, NotificationCategory> = {
  'review.assigned': 'oversight',
  'review.urgent': 'oversight',
  'review.assignment_escalated': 'oversight',
  'review.created': 'oversight', // only pushed to the assignee; resolver decides reach
  'review.reminder': 'oversight',
  'review.decided': 'my_activity',
  'review.sent_back': 'my_activity',
  'review.questions_raised': 'my_activity',
  'chain.completed': 'my_activity',
  'chain.rejected': 'my_activity',
}

export function categoryForEvent(event: string): NotificationCategory | null {
  return EVENT_CATEGORY[event] ?? null
}

/**
 * Categories that at least one event actually maps to.
 *
 * The preference matrix renders from this rather than from
 * NOTIFICATION_CATEGORIES, so a row is never shown for a category nothing can
 * ever fire into. `workspace` and `updates` are declared and stored, but no
 * event maps to them today; the day one does, its row appears with no UI edit.
 */
export function categoriesWithEvents(): NotificationCategory[] {
  const present = new Set(Object.values(EVENT_CATEGORY))
  return NOTIFICATION_CATEGORIES.filter((c) => present.has(c))
}

export interface ChannelToggle {
  email: boolean
  slack: boolean
}
export interface NotificationPrefs {
  // in_app is always on and not stored as a toggle — it is the floor.
  channels: Record<NotificationCategory, ChannelToggle>
  timezone: string | null
  quiet_hours: { start: string; end: string } | null // "HH:mm" local
  digest: { enabled: boolean; at: string } // "HH:mm" local
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  channels: {
    oversight: { email: true, slack: false },
    my_activity: { email: true, slack: false },
    workspace: { email: false, slack: false },
    updates: { email: false, slack: false },
  },
  timezone: null,
  quiet_hours: null,
  digest: { enabled: false, at: '09:00' },
}

/** Minutes since local midnight for "HH:mm". */
function hhmmToMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Local wall-clock minutes for `date` in `timeZone`, or null if the zone is unusable. */
function localMinutes(date: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date)
    const h = Number(parts.find((p) => p.type === 'hour')?.value)
    const min = Number(parts.find((p) => p.type === 'minute')?.value)
    if (Number.isNaN(h) || Number.isNaN(min)) return null
    return (h % 24) * 60 + min
  } catch {
    return null
  }
}

/**
 * Ceiling on how long quiet hours may ever defer a send, regardless of the
 * configured window. Two independent reasons: the email fallback is enqueued
 * on pg-boss with `expireInHours: 24` (apps/api/src/services/jobs/pg-boss-client.ts),
 * so a deferral that approaches that boundary risks the job expiring before it
 * ever fires; and separately, deferring a notification for most of a day is
 * the wrong behavior on its own merits even if the queue tolerated it. A real
 * 22:00-07:00 window (9h) sits comfortably under this cap; only a pathological
 * window (for example 23:59-23:58, "quiet" all but one minute of the day) can
 * approach the uncapped 24h.
 */
export const QUIET_HOURS_MAX_DEFERRAL_SECONDS = 12 * 60 * 60

/**
 * How long to actually wait before sending, given the recipient's quiet hours.
 *
 * Quiet hours are a courtesy, never a gate: this only ever DELAYS a send to the
 * end of the window, and urgent mail bypasses entirely. Anything unparseable (a
 * bad zone, a malformed window) falls back to the base delay, because a stored
 * preference must never be able to stop a notification.
 */
export function quietHoursDelaySeconds(args: {
  baseDelaySeconds: number
  now: Date
  quietHours: { start: string; end: string } | null
  timezone: string | null
  isUrgent: boolean
}): number {
  const { baseDelaySeconds, now, quietHours, timezone, isUrgent } = args
  if (isUrgent || !quietHours) return baseDelaySeconds

  const start = hhmmToMinutes(quietHours.start)
  const end = hhmmToMinutes(quietHours.end)
  if (start === null || end === null || start === end) return baseDelaySeconds

  const fireAt = new Date(now.getTime() + baseDelaySeconds * 1000)
  const fireMinutes = localMinutes(fireAt, timezone ?? 'UTC')
  if (fireMinutes === null) return baseDelaySeconds

  // A window crossing midnight (22:00-07:00) is "inside" when the time is at or
  // after start OR before end; a same-day window is the plain between.
  const crossesMidnight = start > end
  const inside = crossesMidnight
    ? fireMinutes >= start || fireMinutes < end
    : fireMinutes >= start && fireMinutes < end
  if (!inside) return baseDelaySeconds

  const minutesUntilEnd = (end - fireMinutes + 1440) % 1440
  return Math.min(baseDelaySeconds + minutesUntilEnd * 60, QUIET_HOURS_MAX_DEFERRAL_SECONDS)
}

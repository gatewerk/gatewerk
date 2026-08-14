import { eq } from 'drizzle-orm'
import { organizations } from '@gatewerk/db'
import type { AppDb } from '@gatewerk/db'

/**
 * Whether this tenant's outbound mail is currently paused by the deliverability
 * breaker.
 *
 * A null organization is never paused. An unattributed send has no tenant to
 * protect, and blocking it would silently kill mail the breaker was never
 * pointed at.
 */
export async function isTenantPaused(db: AppDb, orgId: string | null): Promise<boolean> {
  if (orgId === null) return false
  const [row] = await db
    .select({ paused: organizations.email_paused_at })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  return Boolean(row?.paused)
}

export async function pauseTenant(db: AppDb, orgId: string, reason: string): Promise<void> {
  await db
    .update(organizations)
    .set({ email_paused_at: new Date(), email_pause_reason: reason })
    .where(eq(organizations.id, orgId))
}

export async function resumeTenant(db: AppDb, orgId: string): Promise<void> {
  // Stamping email_resumed_at is what lets the hourly evaluator (Fix 1) know
  // rows before this instant are stale: without it the evaluator re reads
  // the same breaching 24h window on its very next run and re pauses the
  // tenant within the hour, with zero new sends, making this route a no op
  // in practice.
  await db
    .update(organizations)
    .set({ email_paused_at: null, email_pause_reason: null, email_resumed_at: new Date() })
    .where(eq(organizations.id, orgId))
}

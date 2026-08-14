import { eq } from 'drizzle-orm'
import { notificationSuppressions } from '@gatewerk/db'
import type { AppDb } from '@gatewerk/db'
import { generateId } from '@gatewerk/shared'

export type SuppressionReason = 'bounce' | 'complaint' | 'unsubscribe'

export function normalizeEmail(address: string): string {
  return address.trim().toLowerCase()
}

export async function isSuppressed(db: AppDb, address: string): Promise<boolean> {
  const norm = normalizeEmail(address)
  const rows = await db
    .select({ id: notificationSuppressions.id })
    .from(notificationSuppressions)
    .where(eq(notificationSuppressions.address, norm))
    .limit(1)
  return rows.length > 0
}

export async function suppress(
  db: AppDb,
  address: string,
  reason: SuppressionReason,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const norm = normalizeEmail(address)
  await db
    .insert(notificationSuppressions)
    .values({ id: generateId('suppression'), address: norm, reason, metadata: metadata ?? null })
    .onConflictDoUpdate({
      target: notificationSuppressions.address,
      set: { reason, metadata: metadata ?? null },
    })
}

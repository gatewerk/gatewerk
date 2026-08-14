import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../../__tests__/helpers/test-db'
import { organizations } from '@gatewerk/db'
import { isTenantPaused, pauseTenant, resumeTenant } from './pause'

// isTenantPaused only reads email_paused_at, so it can never catch a resumeTenant
// that clears the timestamp but leaves a stale reason behind. These tests read the
// organizations row directly so both columns are covered independently of that helper.
async function loadOrg(db: any, orgId: string) {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1)
  return row
}

describe('tenant email pause', () => {
  let db: any

  beforeEach(async () => {
    ;({ db } = await createTestDb())
    await db.insert(organizations).values({ id: 'org1', name: 'Org One', slug: 'org-one' })
  })

  it('a fresh organization is not paused', async () => {
    expect(await isTenantPaused(db, 'org1')).toBe(false)
  })

  it('pausing then reading reports paused', async () => {
    await pauseTenant(db, 'org1', 'bounce rate 0.4 over 50 sends')
    expect(await isTenantPaused(db, 'org1')).toBe(true)
  })

  it('pausing records the exact reason and a pause timestamp', async () => {
    await pauseTenant(db, 'org1', 'bounce rate 0.4 over 50 sends')
    const row = await loadOrg(db, 'org1')
    expect(row.email_pause_reason).toBe('bounce rate 0.4 over 50 sends')
    expect(row.email_paused_at).not.toBeNull()
  })

  it('resuming clears the pause', async () => {
    await pauseTenant(db, 'org1', 'bounce rate 0.4 over 50 sends')
    await resumeTenant(db, 'org1')
    expect(await isTenantPaused(db, 'org1')).toBe(false)
  })

  it('resuming clears both the timestamp and the reason, leaving no stale explanation', async () => {
    await pauseTenant(db, 'org1', 'bounce rate 0.4 over 50 sends')
    await resumeTenant(db, 'org1')
    const row = await loadOrg(db, 'org1')
    expect(row.email_paused_at).toBeNull()
    expect(row.email_pause_reason).toBeNull()
  })

  it('resuming stamps email_resumed_at so the evaluator can clamp its window (Fix 1)', async () => {
    await pauseTenant(db, 'org1', 'bounce rate 0.4 over 50 sends')
    const before = await loadOrg(db, 'org1')
    expect(before.email_resumed_at).toBeNull()

    await resumeTenant(db, 'org1')
    const after = await loadOrg(db, 'org1')
    expect(after.email_resumed_at).not.toBeNull()
  })

  it('a null organization is never paused, so unattributed sends still go', async () => {
    expect(await isTenantPaused(db, null)).toBe(false)
  })

  it('an unknown organization is not paused', async () => {
    expect(await isTenantPaused(db, 'does-not-exist')).toBe(false)
  })
})

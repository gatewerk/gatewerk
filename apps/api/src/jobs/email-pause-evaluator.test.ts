import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../__tests__/helpers/test-db'
import { organizations, emailSends } from '@gatewerk/db'
import { generateId } from '@gatewerk/shared'
import { createAuditService } from '../services/audit'
import { isTenantPaused, pauseTenant, resumeTenant } from '../services/email/pause'
import { evaluateEmailPause, MIN_SAMPLE } from './email-pause-evaluator'

async function seedSends(
  db: any,
  opts: { orgId: string; total: number; bounced?: number; complained?: number; ageHours?: number },
) {
  const age = opts.ageHours ?? 0
  for (let i = 0; i < opts.total; i++) {
    await db.insert(emailSends).values({
      id: generateId('email_send'),
      message_id: `${opts.orgId}-${age}-${i}`,
      organization_id: opts.orgId,
      address: `u${i}@x.co`,
      is_transactional: true,
      bounced_at: i < (opts.bounced ?? 0) ? new Date() : null,
      complained_at: i < (opts.complained ?? 0) ? new Date() : null,
      created_at: new Date(Date.now() - age * 3600_000),
    })
  }
}

describe('evaluateEmailPause', () => {
  let db: any
  let audit: ReturnType<typeof createAuditService>

  beforeEach(async () => {
    ;({ db } = await createTestDb())
    audit = createAuditService(db)
    await db.insert(organizations).values([
      { id: 'orgA', name: 'A', slug: 'a' },
      { id: 'orgB', name: 'B', slug: 'b' },
    ])
  })

  it('pauses a tenant over the bounce limit', async () => {
    await seedSends(db, { orgId: 'orgA', total: 50, bounced: 10 }) // 20%
    await evaluateEmailPause(db, audit)
    expect(await isTenantPaused(db, 'orgA')).toBe(true)
  })

  it('leaves a healthy tenant alone', async () => {
    await seedSends(db, { orgId: 'orgA', total: 50, bounced: 1 }) // 2%
    await evaluateEmailPause(db, audit)
    expect(await isTenantPaused(db, 'orgA')).toBe(false)
  })

  it('does not pause below the minimum sample, however bad the rate', async () => {
    await seedSends(db, { orgId: 'orgA', total: MIN_SAMPLE - 1, bounced: MIN_SAMPLE - 1 }) // 100%
    await evaluateEmailPause(db, audit)
    expect(await isTenantPaused(db, 'orgA')).toBe(false)
  })

  it('pauses on complaints at a far lower rate than bounces', async () => {
    await seedSends(db, { orgId: 'orgA', total: 100, complained: 1 }) // 1%, ten times the limit
    await evaluateEmailPause(db, audit)
    expect(await isTenantPaused(db, 'orgA')).toBe(true)
  })

  it('ignores sends outside the window', async () => {
    await seedSends(db, { orgId: 'orgA', total: 50, bounced: 40, ageHours: 72 })
    await evaluateEmailPause(db, audit)
    expect(await isTenantPaused(db, 'orgA')).toBe(false)
  })

  it('pauses only the offending tenant', async () => {
    await seedSends(db, { orgId: 'orgA', total: 50, bounced: 25 })
    await seedSends(db, { orgId: 'orgB', total: 50, bounced: 0 })
    await evaluateEmailPause(db, audit)
    expect(await isTenantPaused(db, 'orgA')).toBe(true)
    expect(await isTenantPaused(db, 'orgB')).toBe(false)
  })

  // I5: every other seed above uses ageHours 0, so a regression that quietly
  // shrinks the window would still pass all of them. This send is fixed at
  // 23.9h old (not derived from PAUSE_WINDOW_HOURS, so shrinking the actual
  // window moves this test's expectation, not just its own arithmetic) to
  // prove sends near the edge of the real 24h boundary are still counted.
  it('still counts a send just inside the window boundary', async () => {
    await seedSends(db, { orgId: 'orgA', total: 50, bounced: 10, ageHours: 23.9 }) // 20%, 23.9h old
    await evaluateEmailPause(db, audit)
    expect(await isTenantPaused(db, 'orgA')).toBe(true)
  })

  // I4a: never un-pause automatically. Paused directly (bypassing the
  // evaluator) so this is isolated from the breach-detection logic above —
  // it proves the evaluator leaves an already-paused tenant alone even when
  // its own window looks perfectly healthy, not just when it still breaches.
  it('never un-pauses a tenant automatically, even when its window looks healthy', async () => {
    await pauseTenant(db, 'orgA', 'paused directly for this test')
    await seedSends(db, { orgId: 'orgA', total: 50, bounced: 0 })
    await evaluateEmailPause(db, audit)
    expect(await isTenantPaused(db, 'orgA')).toBe(true)
  })

  // I4b: rows with no organization_id must never be attributed to some
  // other real tenant, and must never crash the evaluator.
  it('skips sends with no organization_id, since there is no tenant to pause', async () => {
    for (let i = 0; i < 50; i++) {
      await db.insert(emailSends).values({
        id: generateId('email_send'),
        message_id: `unattributed-${i}`,
        organization_id: null,
        address: `n${i}@x.co`,
        is_transactional: true,
        bounced_at: i < 40 ? new Date() : null, // 80%, would breach any real tenant
      })
    }
    await seedSends(db, { orgId: 'orgB', total: 50, bounced: 0 })
    await expect(evaluateEmailPause(db, audit)).resolves.toBeUndefined()
    expect(await isTenantPaused(db, 'orgB')).toBe(false)
  })

  // I4c: the already-paused guard must actually suppress a second pause
  // attempt, not just leave the tenant paused (which a re-pause would too).
  it('does not re-pause or re-audit a tenant that is already paused', async () => {
    await seedSends(db, { orgId: 'orgA', total: 50, bounced: 25 }) // 50%, breaches
    await evaluateEmailPause(db, audit)
    expect(await isTenantPaused(db, 'orgA')).toBe(true)

    const first = await audit.query({ action: 'email.tenant_paused', resource_id: 'orgA' })
    expect(first.items).toHaveLength(1)

    await evaluateEmailPause(db, audit) // still breaching; guard should skip
    const second = await audit.query({ action: 'email.tenant_paused', resource_id: 'orgA' })
    expect(second.items).toHaveLength(1)
  })

  // I4d: the pause decision must leave an audit trail, and I8's reason
  // string must actually name real numbers, dash free.
  it('writes an audit row when it pauses a tenant', async () => {
    await seedSends(db, { orgId: 'orgA', total: 50, bounced: 10 }) // 20%
    await evaluateEmailPause(db, audit)

    const { items } = await audit.query({ action: 'email.tenant_paused', resource_id: 'orgA' })
    expect(items).toHaveLength(1)
    expect(items[0].actor).toBe('system:email_pause_evaluator')
    expect(items[0].details).toMatchObject({ metric: 'bounce', total: 50, bounced: 10 })
    const reason = String((items[0].details as any)?.reason ?? '')
    expect(reason).not.toHaveLength(0)
    expect(reason).not.toContain('-')
  })

  // Fix 1: without the email_resumed_at clamp, the evaluator re-reads the
  // SAME breaching 24h window on its very next run and re-pauses the tenant
  // within the hour, with zero new sends. That would make the admin resume
  // route useless in practice. This test seeds a breach, evaluates once,
  // resumes, then evaluates again with no new sends at all and asserts the
  // tenant stays unpaused. It genuinely fails against the pre-fix
  // implementation: with the clamp removed, the stale breaching rows are
  // still inside the unclamped 24h window and re-trigger the pause.
  it('does not re-pause a resumed tenant when no new sends have happened', async () => {
    await seedSends(db, { orgId: 'orgA', total: 50, bounced: 25 }) // 50%, breaches
    await evaluateEmailPause(db, audit)
    expect(await isTenantPaused(db, 'orgA')).toBe(true)

    // Separates the seeded rows' created_at from the resume timestamp by
    // more than clock resolution, so the >= clamp boundary is never a race.
    await new Promise((r) => setTimeout(r, 5))
    await resumeTenant(db, 'orgA')
    expect(await isTenantPaused(db, 'orgA')).toBe(false)

    // No new sends inserted here at all: the only rows that exist predate
    // the resume. A correct evaluator must see zero eligible rows for orgA.
    await evaluateEmailPause(db, audit)
    expect(await isTenantPaused(db, 'orgA')).toBe(false)
  })

  // Fix 1's mirror: the breaker must not be permanently disarmed by a
  // resume. New breaching sends AFTER the resume must still trip it.
  it('re-pauses a resumed tenant when new breaching sends arrive after the resume', async () => {
    await seedSends(db, { orgId: 'orgA', total: 50, bounced: 25 }) // 50%, breaches
    await evaluateEmailPause(db, audit)
    expect(await isTenantPaused(db, 'orgA')).toBe(true)

    await new Promise((r) => setTimeout(r, 5))
    await resumeTenant(db, 'orgA')
    expect(await isTenantPaused(db, 'orgA')).toBe(false)

    await new Promise((r) => setTimeout(r, 5))
    // New breaching volume, all created after the resume. Seeded directly
    // (not via seedSends) because seedSends' message_id template is
    // `${orgId}-${age}-${i}`: a second call with the same orgId and the same
    // default ageHours of 0 would collide with the pre-resume batch above on
    // the email_sends message_id unique index.
    for (let i = 0; i < 50; i++) {
      await db.insert(emailSends).values({
        id: generateId('email_send'),
        message_id: `orgA-post-resume-${i}`,
        organization_id: 'orgA',
        address: `p${i}@x.co`,
        is_transactional: true,
        bounced_at: i < 25 ? new Date() : null, // 50%, breaches
        created_at: new Date(),
      })
    }
    await evaluateEmailPause(db, audit)
    expect(await isTenantPaused(db, 'orgA')).toBe(true)
  })
})

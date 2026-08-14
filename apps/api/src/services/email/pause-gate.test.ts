import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTestDb } from '../../__tests__/helpers/test-db'
import { organizations, emailSends } from '@gatewerk/db'
import { eq } from 'drizzle-orm'
import { createEmailService } from './index'
import type { EmailTransport, EmailTransportSendInput } from './transport'
import { isTenantPaused } from './pause'
import { recordSend, markSendFailure } from './send-log'

/**
 * Minimal audit stub — satisfies the `audit` dep without a DB. Only
 * `log` is called from the send path; all other audit methods are no-ops.
 * Mirrors email-suppression-routing.test.ts's setup shape.
 */
function makeAuditStub() {
  return {
    log: vi.fn(async () => {}),
    query: vi.fn(async () => ({ rows: [], total: 0 })),
  } as any
}

/**
 * Fake transport that records the envelope passed to send(). Uses the
 * real EmailTransport interface shape (send + close).
 */
function makeTransport(): { transport: EmailTransport; sent: EmailTransportSendInput[] } {
  const sent: EmailTransportSendInput[] = []
  const transport: EmailTransport = {
    send: vi.fn(async (msg: EmailTransportSendInput) => {
      sent.push(msg)
      return { messageId: 'm1' }
    }),
    close: vi.fn(async () => {}),
  }
  return { transport, sent }
}

function makeService(overrides: {
  checkTenantPaused?: (orgId: string | null) => Promise<boolean>
  logSend?: (input: {
    messageId: string
    organizationId: string | null
    address: string
    isTransactional: boolean
  }) => Promise<void>
} = {}) {
  const { transport, sent } = makeTransport()
  const audit = makeAuditStub()

  const svc = createEmailService({
    audit,
    transport,
    ...overrides,
  })

  return { svc, sent, transport, audit }
}

describe('email pause gate', () => {
  let db: any

  beforeEach(async () => {
    ;({ db } = await createTestDb())
    await db.insert(organizations).values([
      {
        id: 'org_paused',
        name: 'Paused Org',
        slug: 'paused-org',
        email_paused_at: new Date(),
        email_pause_reason: 'bounce_rate',
      },
      { id: 'org_ok', name: 'OK Org', slug: 'ok-org' },
    ])
  })

  it('returns tenant_paused and does NOT call transport when the org is paused', async () => {
    const { svc, transport } = makeService({
      checkTenantPaused: (orgId) => isTenantPaused(db, orgId),
    })

    const res = await svc.sendEmail({
      to: 'someone@example.com',
      subject: 'test',
      text: 'hello',
      html: '<p>hello</p>',
      organization_id: 'org_paused',
    })

    expect(res.status).toBe('tenant_paused')
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('sends normally when the org is not paused', async () => {
    const { svc, sent, transport } = makeService({
      checkTenantPaused: (orgId) => isTenantPaused(db, orgId),
    })

    const res = await svc.sendEmail({
      to: 'someone@example.com',
      subject: 'test',
      text: 'hello',
      html: '<p>hello</p>',
      organization_id: 'org_ok',
    })

    expect(res.status).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(transport.send).toHaveBeenCalledTimes(1)
  })

  it('never gates a send with no organization_id (unattributed mail)', async () => {
    const { svc, sent } = makeService({
      checkTenantPaused: async () => true, // would gate everything if consulted
    })

    const res = await svc.sendEmail({
      to: 'someone@example.com',
      subject: 'test',
      text: 'hello',
      html: '<p>hello</p>',
      // organization_id omitted entirely
    })

    expect(res.status).toBe('sent')
    expect(sent).toHaveLength(1)
  })

  it('fails OPEN and still sends when the pause lookup throws', async () => {
    // Deliverability breaker must fail open exactly like the suppression
    // gate: a database blip must never silently stop a tenant's mail.
    const { svc, sent, transport } = makeService({
      checkTenantPaused: async () => {
        throw new Error('db down')
      },
    })

    const res = await svc.sendEmail({
      to: 'someone@example.com',
      subject: 'test',
      text: 'hello',
      html: '<p>hello</p>',
      organization_id: 'org_ok',
    })

    expect(res.status).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(transport.send).toHaveBeenCalledTimes(1)
  })

  it('logs a successful attributed send to email_sends', async () => {
    const { svc } = makeService({
      checkTenantPaused: (orgId) => isTenantPaused(db, orgId),
      logSend: (input) => recordSend(db, input),
    })

    const res = await svc.sendEmail({
      to: 'attributed@example.com',
      subject: 'test',
      text: 'hello',
      html: '<p>hello</p>',
      organization_id: 'org_ok',
    })

    expect(res.status).toBe('sent')
    if (res.status !== 'sent') throw new Error('unreachable')

    const [row] = await db
      .select()
      .from(emailSends)
      .where(eq(emailSends.message_id, res.messageId))
    expect(row).toBeDefined()
    expect(row.organization_id).toBe('org_ok')
  })

  it('still reports sent with the real messageId when logSend rejects after a successful transport send', async () => {
    // A logging failure must never turn an already delivered email into a
    // reported failure. This is a live send path: the recipient's mailbox
    // already has the message by the time logSend runs, so the caller's
    // result MUST reflect that regardless of what the attribution log does.
    const { svc, sent, transport } = makeService({
      checkTenantPaused: (orgId) => isTenantPaused(db, orgId),
      logSend: async () => {
        throw new Error('db down')
      },
    })

    const res = await svc.sendEmail({
      to: 'attributed@example.com',
      subject: 'test',
      text: 'hello',
      html: '<p>hello</p>',
      organization_id: 'org_ok',
    })

    expect(res.status).toBe('sent')
    if (res.status !== 'sent') throw new Error('unreachable')
    expect(res.messageId).toBe('m1')
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
  })

  // Fix 2: sendTestEmail previously never called logSend at all, so an admin
  // Send-test had no row of its own. These tests would fail against that
  // implementation: the first asserts a row exists with organization_id
  // null, which is simply absent pre-fix; the second proves the practical
  // consequence, that a bounce to the tested address lands on the earlier
  // real tenant's send instead of on nobody.
  describe('sendTestEmail attribution (Fix 2)', () => {
    it('logs a test send with a null organization', async () => {
      const { svc } = makeService({
        logSend: (input) => recordSend(db, input),
      })

      const result = await svc.sendTestEmail({
        to: 'diag@example.com',
        subject: 'test',
        text: 'hello',
        html: '<p>hello</p>',
      })

      expect(result.status).toBe('sent')
      if (result.status !== 'sent') throw new Error('unreachable')

      const [row] = await db
        .select()
        .from(emailSends)
        .where(eq(emailSends.message_id, result.messageId))
      expect(row).toBeDefined()
      expect(row.organization_id).toBeNull()
    })

    it('attributes a bounce after a test send to the null organization row, not to an earlier real tenant send', async () => {
      // org_ok mailed this exact address earlier. Without Fix 2, this is the
      // row the address fallback lands on and the bounce is mis-attributed
      // to org_ok's tenant instead of to the diagnostic send that caused it.
      await recordSend(db, {
        messageId: 'earlier-real-send',
        organizationId: 'org_ok',
        address: 'shared@example.com',
        isTransactional: true,
      })

      const { svc } = makeService({
        logSend: (input) => recordSend(db, input),
      })

      const result = await svc.sendTestEmail({
        to: 'shared@example.com',
        subject: 'test',
        text: 'hello',
        html: '<p>hello</p>',
      })
      expect(result.status).toBe('sent')
      if (result.status !== 'sent') throw new Error('unreachable')

      await markSendFailure(db, { messageId: null, address: 'shared@example.com', kind: 'bounce' })

      const [testRow] = await db
        .select()
        .from(emailSends)
        .where(eq(emailSends.message_id, result.messageId))
      const [earlierRow] = await db
        .select()
        .from(emailSends)
        .where(eq(emailSends.message_id, 'earlier-real-send'))

      expect(testRow.bounced_at).not.toBeNull()
      expect(testRow.organization_id).toBeNull()
      expect(earlierRow.bounced_at).toBeNull()
    })
  })
})

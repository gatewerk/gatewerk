import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTestDb } from '../../__tests__/helpers/test-db'
import { organizations, emailSends } from '@gatewerk/db'
import { eq } from 'drizzle-orm'
import { generateId } from '@gatewerk/shared'
import { recordSend, markSendFailure, ADDRESS_FALLBACK_WINDOW_HOURS } from './send-log'
import { createEmailService } from './index'
import type { EmailTransport, EmailTransportSendInput } from './transport'

describe('recordSend', () => {
  let db: any

  beforeEach(async () => {
    ;({ db } = await createTestDb())
    await db.insert(organizations).values({ id: 'org1', name: 'Org One', slug: 'org-one' })
  })

  it('logs a send against its organization', async () => {
    await recordSend(db, {
      messageId: 'msg-1',
      organizationId: 'org1',
      address: 'A@Example.com',
      isTransactional: true,
    })

    const [row] = await db.select().from(emailSends).where(eq(emailSends.message_id, 'msg-1'))
    expect(row.organization_id).toBe('org1')
    expect(row.is_transactional).toBe(true)
  })

  it('normalizes the address so the webhook fallback can match it', async () => {
    await recordSend(db, {
      messageId: 'msg-2',
      organizationId: 'org1',
      address: 'MiXeD@Example.com',
      isTransactional: true,
    })

    const [row] = await db.select().from(emailSends).where(eq(emailSends.message_id, 'msg-2'))
    expect(row.address).toBe('mixed@example.com')
  })

  it('logs an unattributed send with a null organization', async () => {
    await recordSend(db, {
      messageId: 'msg-3',
      organizationId: null,
      address: 'x@example.com',
      isTransactional: false,
    })

    const [row] = await db.select().from(emailSends).where(eq(emailSends.message_id, 'msg-3'))
    expect(row.organization_id).toBeNull()
  })

  it('persists a supplied notificationId', async () => {
    await recordSend(db, {
      messageId: 'msg-notif-1',
      organizationId: 'org1',
      address: 'a@example.com',
      isTransactional: true,
      notificationId: 'gw_notif_abc123',
    })

    const [row] = await db.select().from(emailSends).where(eq(emailSends.message_id, 'msg-notif-1'))
    expect(row.notification_id).toBe('gw_notif_abc123')
  })

  it('stores a null notification_id when notificationId is omitted', async () => {
    await recordSend(db, {
      messageId: 'msg-notif-2',
      organizationId: 'org1',
      address: 'a@example.com',
      isTransactional: true,
    })

    const [row] = await db.select().from(emailSends).where(eq(emailSends.message_id, 'msg-notif-2'))
    expect(row.notification_id).toBeNull()
  })

  it('is idempotent on a repeated message id', async () => {
    const args = {
      messageId: 'msg-4',
      organizationId: 'org1',
      address: 'x@example.com',
      isTransactional: true,
    }
    await recordSend(db, args)
    await recordSend(db, args)

    const rows = await db.select().from(emailSends).where(eq(emailSends.message_id, 'msg-4'))
    expect(rows).toHaveLength(1)
  })
})

describe('markSendFailure', () => {
  let db: any

  beforeEach(async () => {
    ;({ db } = await createTestDb())
    await db.insert(organizations).values({ id: 'org1', name: 'Org One', slug: 'org-one' })
  })

  it('marks the row matching the provider message id, preferring it over a newer send to the same address', async () => {
    // A second, newer send to the same address is what makes this test
    // discriminate id preference from the address fallback: with only one
    // row for the address, both code paths would land on the same row.
    await recordSend(db, { messageId: 'm1', organizationId: 'org1', address: 'a@x.co', isTransactional: true })
    await new Promise((r) => setTimeout(r, 5))
    await recordSend(db, { messageId: 'm1-newer', organizationId: 'org1', address: 'a@x.co', isTransactional: true })

    await markSendFailure(db, { messageId: 'm1', address: 'a@x.co', kind: 'bounce' })

    const [row] = await db.select().from(emailSends).where(eq(emailSends.message_id, 'm1'))
    const [newerRow] = await db.select().from(emailSends).where(eq(emailSends.message_id, 'm1-newer'))
    expect(row.bounced_at).not.toBeNull()
    expect(row.complained_at).toBeNull()
    expect(newerRow.bounced_at).toBeNull()
  })

  it('falls back to the most recent send to the address when no message id is given', async () => {
    await recordSend(db, { messageId: 'old', organizationId: 'org1', address: 'a@x.co', isTransactional: true })
    await new Promise((r) => setTimeout(r, 5))
    await recordSend(db, { messageId: 'new', organizationId: 'org1', address: 'a@x.co', isTransactional: true })

    await markSendFailure(db, { messageId: null, address: 'a@x.co', kind: 'complaint' })

    const [oldRow] = await db.select().from(emailSends).where(eq(emailSends.message_id, 'old'))
    const [newRow] = await db.select().from(emailSends).where(eq(emailSends.message_id, 'new'))
    expect(newRow.complained_at).not.toBeNull()
    expect(oldRow.complained_at).toBeNull()
  })

  it('matches the address case insensitively', async () => {
    // Lookup address is upper cased on purpose: recordSend always normalizes
    // the stored row to lower case regardless, so a lower cased lookup here
    // would pass even if markSendFailure stopped normalizing its own input.
    await recordSend(db, { messageId: 'm2', organizationId: 'org1', address: 'Mixed@X.co', isTransactional: true })
    await markSendFailure(db, { messageId: null, address: 'MIXED@X.CO', kind: 'bounce' })

    const [row] = await db.select().from(emailSends).where(eq(emailSends.message_id, 'm2'))
    expect(row.bounced_at).not.toBeNull()
  })

  it('is a no-op when nothing matches, never throwing', async () => {
    await expect(
      markSendFailure(db, { messageId: 'nope', address: 'nobody@x.co', kind: 'bounce' }),
    ).resolves.toBeUndefined()
  })

  // Fix 2: the address fallback used to have no time bound at all, so an
  // ancient send to the same address could absorb a fresh bounce. This test
  // genuinely fails against that implementation: with no bound, the
  // "ancient" row below is the only match for the address and WOULD be
  // marked, so removing the bound flips this assertion.
  it('does not mark a send older than the fallback window when no message id is given', async () => {
    await db.insert(emailSends).values({
      id: generateId('email_send'),
      message_id: 'ancient',
      organization_id: 'org1',
      address: 'stale@x.co',
      is_transactional: true,
      created_at: new Date(Date.now() - (ADDRESS_FALLBACK_WINDOW_HOURS + 1) * 3600_000),
    })

    await markSendFailure(db, { messageId: null, address: 'stale@x.co', kind: 'bounce' })

    const [row] = await db.select().from(emailSends).where(eq(emailSends.message_id, 'ancient'))
    expect(row.bounced_at).toBeNull()
  })
})

describe('email service correlates a send to its notification (Task 6)', () => {
  let db: any

  beforeEach(async () => {
    ;({ db } = await createTestDb())
  })

  function makeTransport(): { transport: EmailTransport; sent: EmailTransportSendInput[] } {
    const sent: EmailTransportSendInput[] = []
    const transport: EmailTransport = {
      send: vi.fn(async (msg: EmailTransportSendInput) => {
        sent.push(msg)
        return { messageId: 'notif-correlation-msg' }
      }),
      close: vi.fn(async () => {}),
    }
    return { transport, sent }
  }

  function makeAuditStub() {
    return {
      log: vi.fn(async () => {}),
      query: vi.fn(async () => ({ rows: [], total: 0 })),
    } as any
  }

  it('a send made through the email service with notification_id set produces an email_sends row carrying it', async () => {
    const { transport } = makeTransport()
    const audit = makeAuditStub()
    const svc = createEmailService({
      audit,
      transport,
      logSend: (input) => recordSend(db, input),
    })

    const res = await svc.sendEmail({
      to: 'reviewer@example.com',
      subject: 'your turn',
      text: 'hello',
      html: '<p>hello</p>',
      notification_id: 'gw_notif_xyz789',
    })

    expect(res.status).toBe('sent')
    if (res.status !== 'sent') throw new Error('unreachable')

    const [row] = await db.select().from(emailSends).where(eq(emailSends.message_id, res.messageId))
    expect(row).toBeDefined()
    expect(row.notification_id).toBe('gw_notif_xyz789')
  })

  it('a send with no notification_id produces a row with a null notification_id', async () => {
    const { transport } = makeTransport()
    const audit = makeAuditStub()
    const svc = createEmailService({
      audit,
      transport,
      logSend: (input) => recordSend(db, input),
    })

    const res = await svc.sendEmail({
      to: 'reviewer@example.com',
      subject: 'your turn',
      text: 'hello',
      html: '<p>hello</p>',
    })

    expect(res.status).toBe('sent')
    if (res.status !== 'sent') throw new Error('unreachable')

    const [row] = await db.select().from(emailSends).where(eq(emailSends.message_id, res.messageId))
    expect(row).toBeDefined()
    expect(row.notification_id).toBeNull()
  })
})

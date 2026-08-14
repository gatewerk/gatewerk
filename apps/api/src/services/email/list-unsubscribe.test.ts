import { describe, it, expect, vi } from 'vitest'
import { createEmailService } from './index'
import type { EmailTransport, EmailTransportSendInput } from './transport'

/**
 * Minimal audit stub — satisfies the `audit` dep without a DB. Only
 * `log` is called from the send path; all other audit methods are no-ops.
 */
function makeAuditStub() {
  return {
    log: vi.fn(async () => {}),
    query: vi.fn(async () => ({ rows: [], total: 0 })),
  } as any
}

/**
 * Fake transport that records the full envelope (including headers) passed
 * to send(). Mirrors the Stage-2 email-suppression-routing.test.ts setup.
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

function makeService() {
  const { transport, sent } = makeTransport()
  const audit = makeAuditStub()

  const svc = createEmailService({ audit, transport })

  return { svc, sent, transport, audit }
}

describe('List-Unsubscribe header injection (RFC 8058)', () => {
  it('emits URL + mailto List-Unsubscribe AND List-Unsubscribe-Post when listUnsubscribeUrl is set', async () => {
    const { svc, sent } = makeService()

    const res = await svc.sendEmail({
      to: 'user@example.com',
      subject: 'Daily digest',
      text: 'digest body',
      html: '<p>digest body</p>',
      listUnsubscribeUrl: 'https://api.x/api/v1/unsub/T',
      is_transactional: false,
    })

    expect(res.status).toBe('sent')
    expect(sent).toHaveLength(1)

    const headers = sent[0]!.headers
    // The List-Unsubscribe header must contain the HTTPS URL (RFC 8058 one-click)
    expect(headers['List-Unsubscribe']).toContain('<https://api.x/api/v1/unsub/T>')
    // It must also contain a mailto fallback
    expect(headers['List-Unsubscribe']).toContain('<mailto:')
    // The one-click POST header must be present
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('emits mailto-only List-Unsubscribe and NO List-Unsubscribe-Post when listUnsubscribeUrl is NOT set', async () => {
    const { svc, sent } = makeService()

    const res = await svc.sendEmail({
      to: 'user@example.com',
      subject: 'OTP code',
      text: 'Your code is 123456',
      html: '<p>Your code is 123456</p>',
      // listUnsubscribeUrl intentionally omitted (transactional)
    })

    expect(res.status).toBe('sent')
    expect(sent).toHaveLength(1)

    const headers = sent[0]!.headers
    // Transactional: mailto-only (no URL prefix)
    expect(headers['List-Unsubscribe']).toMatch(/^<mailto:/)
    // One-click POST header must NOT be present for transactional emails
    expect('List-Unsubscribe-Post' in headers).toBe(false)
  })

  it('URL in List-Unsubscribe is the exact URL passed by the caller', async () => {
    const { svc, sent } = makeService()
    const url = 'https://api.gatewerk.com/api/v1/unsubscribe/abc123'

    await svc.sendEmail({
      to: 'user@example.com',
      subject: 'Weekly digest',
      text: 'body',
      html: '<p>body</p>',
      listUnsubscribeUrl: url,
      is_transactional: false,
    })

    const headers = sent[0]!.headers
    expect(headers['List-Unsubscribe']).toContain(`<${url}>`)
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })
})

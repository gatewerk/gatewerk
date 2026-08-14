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
  checkSuppressed?: (address: string) => Promise<boolean>
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

describe('email suppression + stream routing', () => {
  it('returns suppressed and does NOT call transport when checkSuppressed returns true', async () => {
    const { svc, transport } = makeService({
      checkSuppressed: async () => true,
    })

    const res = await svc.sendEmail({
      to: 'dead@x.co',
      subject: 'test',
      text: 'hello',
      html: '<p>hello</p>',
    })

    expect(res.status).toBe('suppressed')
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('does NOT suppress when checkSuppressed returns false', async () => {
    const { svc, sent } = makeService({
      checkSuppressed: async () => false,
    })

    const res = await svc.sendEmail({
      to: 'ok@x.co',
      subject: 'test',
      text: 'hello',
      html: '<p>hello</p>',
    })

    expect(res.status).toBe('sent')
    expect(sent).toHaveLength(1)
  })

  it('fails OPEN and still sends when checkSuppressed rejects', async () => {
    // NEVER-throws invariant: a suppression-check outage (e.g. transient DB
    // hiccup) must not escape sendEmail nor block legitimate mail. The gate
    // sits outside Branch 4's try-catch, so without its own guard the
    // rejection would surface as an unhandled 500 / crash the digest loop.
    const { svc, transport, sent } = makeService({
      checkSuppressed: async () => {
        throw new Error('db down')
      },
    })

    const res = await svc.sendEmail({
      to: 'ok@x.co',
      subject: 'test',
      text: 'hello',
      html: '<p>hello</p>',
    })

    expect(res.status).toBe('sent')
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
  })

  it('routes is_transactional=true to txFrom', async () => {
    // Override smtp config via vi.stubEnv is complex at this layer since
    // config is module-level. Instead we rely on the injected transport
    // path and verify fromAddr via the sent envelope. The service uses
    // smtp.txFrom ?? smtp.from ?? sentinel. With no SMTP env set in test
    // mode, smtp.from / txFrom / notifyFrom are all undefined, so fromAddr
    // falls back to the sentinel. To exercise stream routing we mock
    // config.smtp directly on the module.
    //
    // Approach: patch config.smtp for the duration of the test using
    // vi.mock is complex for a singleton module. Instead we verify the
    // behaviour by constructing a service with a real config replacement
    // approach: import the config and temporarily set values.
    //
    // Simpler: check that when both txFrom and notifyFrom are set via
    // process.env, the service routes correctly. But optionalEnv returns
    // undefined in test mode. So we test the routing logic indirectly
    // via the config module's smtp object.
    //
    // Since config.smtp is read at createEmailService call time (closure
    // over `const smtp = config.smtp`), we can mutate config.smtp
    // before constructing the service.

    const { config } = await import('../../config')

    const origTxFrom = (config.smtp as any).txFrom
    const origNotifyFrom = (config.smtp as any).notifyFrom
    const origFrom = (config.smtp as any).from

    try {
      ;(config.smtp as any).txFrom = 'tx@tx.gw.co'
      ;(config.smtp as any).notifyFrom = 'n@notify.gw.co'
      ;(config.smtp as any).from = 'base@gw.co'

      const { svc, sent } = makeService({ checkSuppressed: async () => false })

      await svc.sendEmail({
        to: 'a@x.co',
        subject: 's',
        text: 't',
        html: '<p>t</p>',
        is_transactional: true,
      })
      await svc.sendEmail({
        to: 'b@x.co',
        subject: 's',
        text: 't',
        html: '<p>t</p>',
        is_transactional: false,
      })

      expect(sent[0]?.from).toContain('tx@tx.gw.co')
      expect(sent[1]?.from).toContain('n@notify.gw.co')
    } finally {
      ;(config.smtp as any).txFrom = origTxFrom
      ;(config.smtp as any).notifyFrom = origNotifyFrom
      ;(config.smtp as any).from = origFrom
    }
  })

  it('defaults undefined is_transactional to transactional (txFrom path)', async () => {
    const { config } = await import('../../config')

    const origTxFrom = (config.smtp as any).txFrom
    const origNotifyFrom = (config.smtp as any).notifyFrom
    const origFrom = (config.smtp as any).from

    try {
      ;(config.smtp as any).txFrom = 'tx@tx.gw.co'
      ;(config.smtp as any).notifyFrom = 'n@notify.gw.co'
      ;(config.smtp as any).from = 'base@gw.co'

      const { svc, sent } = makeService({ checkSuppressed: async () => false })

      await svc.sendEmail({
        to: 'a@x.co',
        subject: 's',
        text: 't',
        html: '<p>t</p>',
        // is_transactional omitted — should default to tx stream
      })

      expect(sent[0]?.from).toContain('tx@tx.gw.co')
    } finally {
      ;(config.smtp as any).txFrom = origTxFrom
      ;(config.smtp as any).notifyFrom = origNotifyFrom
      ;(config.smtp as any).from = origFrom
    }
  })

  it('passes through normally when checkSuppressed is not provided', async () => {
    const { svc, sent } = makeService() // no checkSuppressed

    const res = await svc.sendEmail({
      to: 'any@x.co',
      subject: 'test',
      text: 'hello',
      html: '<p>hello</p>',
    })

    expect(res.status).toBe('sent')
    expect(sent).toHaveLength(1)
  })
})

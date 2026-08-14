import { describe, it, expect } from 'vitest'
import { emailSends } from './email-sends'
import { getTableConfig } from 'drizzle-orm/pg-core'

describe('email_sends schema', () => {
  it('has snake_case columns', () => {
    // getTableConfig().columns[].name is the DB column string passed to text(),
    // not the JS property key, so it cannot catch a camelCase property. Assert
    // on Object.keys directly, matching notification-suppressions.test.ts, so a
    // property like `messageId: text('message_id')` fails this test.
    const cols = Object.keys(emailSends)
    for (const c of [
      'id',
      'message_id',
      'organization_id',
      'address',
      'is_transactional',
      'bounced_at',
      'complained_at',
      'created_at',
    ]) {
      expect(cols).toContain(c)
    }
  })

  it('is named email_sends and keys on the provider message id', () => {
    const t = getTableConfig(emailSends)
    expect(t.name).toBe('email_sends')
    const names = t.columns.map((c) => c.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'message_id',
        'organization_id',
        'address',
        'is_transactional',
        'bounced_at',
        'complained_at',
        'created_at',
      ]),
    )
  })

  it('allows a null organization so OSS and unattributed sends still log', () => {
    const t = getTableConfig(emailSends)
    const org = t.columns.find((c) => c.name === 'organization_id')
    expect(org?.notNull).toBe(false)
  })
})

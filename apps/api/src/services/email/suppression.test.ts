import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../__tests__/helpers/test-db'
import { isSuppressed, suppress, normalizeEmail } from './suppression'

describe('suppression service', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  beforeEach(async () => { ({ db } = await createTestDb()) })

  it('isSuppressed is false, true after suppress', async () => {
    expect(await isSuppressed(db, 'a@x.co')).toBe(false)
    await suppress(db, 'a@x.co', 'bounce')
    expect(await isSuppressed(db, 'a@x.co')).toBe(true)
  })
  it('is idempotent and case/space-insensitive', async () => {
    await suppress(db, '  A@X.co ', 'bounce')
    await suppress(db, 'a@x.co', 'complaint')
    expect(await isSuppressed(db, 'A@x.CO')).toBe(true) // one row, normalized
  })
  it('normalizeEmail lowercases + trims', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com')
  })
})

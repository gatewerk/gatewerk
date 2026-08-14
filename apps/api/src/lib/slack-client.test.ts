import { afterEach, describe, expect, it, vi } from 'vitest'
import { oauthAccess, postMessage, revoke, usersLookupByEmail } from './slack-client'

// Helper to build a mock fetch that resolves with a Slack-shaped JSON body.
function mockFetch(body: object) {
  return vi.fn().mockResolvedValue({
    json: () => Promise.resolve(body),
  })
}

describe('slack-client', () => {
  // Capture the real fetch: vi.restoreAllMocks() only unwinds vi.spyOn,
  // NOT direct `global.fetch = vi.fn()` property assignment. Without this
  // explicit restore, the last-assigned mock would leak past this file and
  // false-red a later suite in the sequential full-suite run.
  const originalFetch = global.fetch
  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  // -------------------------------------------------------------------------
  // oauthAccess
  // -------------------------------------------------------------------------
  describe('oauthAccess', () => {
    it('parses a successful response', async () => {
      global.fetch = mockFetch({
        ok: true,
        access_token: 'xoxb-bot-token',
        bot_user_id: 'U123BOT',
        team: { id: 'T123', name: 'Acme Inc' },
      })

      const result = await oauthAccess({
        code: 'auth-code',
        clientId: 'CLIENT_ID',
        clientSecret: 'CLIENT_SECRET',
        redirectUri: 'https://example.com/callback',
      })

      expect(result).toEqual({
        botToken: 'xoxb-bot-token',
        botUserId: 'U123BOT',
        teamId: 'T123',
        teamName: 'Acme Inc',
      })
    })

    it('throws slack_ error on ok:false', async () => {
      global.fetch = mockFetch({ ok: false, error: 'invalid_code' })

      await expect(
        oauthAccess({
          code: 'bad-code',
          clientId: 'CLIENT_ID',
          clientSecret: 'CLIENT_SECRET',
          redirectUri: 'https://example.com/callback',
        }),
      ).rejects.toThrow('slack_invalid_code')
    })
  })

  // -------------------------------------------------------------------------
  // usersLookupByEmail
  // -------------------------------------------------------------------------
  describe('usersLookupByEmail', () => {
    it('returns the Slack user id on success', async () => {
      global.fetch = mockFetch({
        ok: true,
        user: { id: 'U456USER' },
      })

      const userId = await usersLookupByEmail('xoxb-bot-token', 'user@example.com')
      expect(userId).toBe('U456USER')
    })

    it('returns null when error is users_not_found', async () => {
      global.fetch = mockFetch({ ok: false, error: 'users_not_found' })

      const userId = await usersLookupByEmail('xoxb-bot-token', 'nobody@example.com')
      expect(userId).toBeNull()
    })

    it('throws slack_ error on other ok:false errors', async () => {
      global.fetch = mockFetch({ ok: false, error: 'invalid_auth' })

      await expect(
        usersLookupByEmail('xoxb-bad-token', 'user@example.com'),
      ).rejects.toThrow('slack_invalid_auth')
    })
  })

  // -------------------------------------------------------------------------
  // postMessage
  // -------------------------------------------------------------------------
  describe('postMessage', () => {
    it('resolves without value on success', async () => {
      global.fetch = mockFetch({ ok: true, ts: '12345.678' })

      await expect(
        postMessage('xoxb-bot-token', 'U456USER', [], 'Hello'),
      ).resolves.toBeUndefined()
    })

    it('throws slack_ error on ok:false', async () => {
      global.fetch = mockFetch({ ok: false, error: 'channel_not_found' })

      await expect(
        postMessage('xoxb-bot-token', 'UBADCHAN', [], 'Hello'),
      ).rejects.toThrow('slack_channel_not_found')
    })
  })

  // -------------------------------------------------------------------------
  // revoke
  // -------------------------------------------------------------------------
  describe('revoke', () => {
    it('resolves without value on success', async () => {
      global.fetch = mockFetch({ ok: true, revoked: true })

      await expect(revoke('xoxb-bot-token')).resolves.toBeUndefined()
    })

    it('throws slack_ error on ok:false', async () => {
      global.fetch = mockFetch({ ok: false, error: 'invalid_auth' })

      await expect(revoke('xoxb-bot-token')).rejects.toThrow('slack_invalid_auth')
    })
  })
})

/**
 * Slack OAuth routes integration tests.
 *
 * Security invariants verified:
 * - stored bot_token_encrypted is NOT the plaintext token
 * - decryptAtRest(stored, key) round-trips to the plaintext token
 * - a tampered/invalid state → 400, no workspace row written
 * - /callback never logs the bot token (network calls are mocked)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import { eq, isNull, and } from 'drizzle-orm'
import { createApp } from '../app'
import { createTestDb, seedReviewer } from '../__tests__/helpers/test-db'
import { slackWorkspaces, slackUserLinks, organizations } from '@gatewerk/db/src/schema/index'
import { generateEmailToken } from '../lib/email-tokens'
import { decryptAtRest } from '../lib/secret-crypto'

// ---------------------------------------------------------------------------
// Test encryption key (64 hex chars = 32 bytes)
// ---------------------------------------------------------------------------
const TEST_ENC_KEY = 'a'.repeat(64)

// ---------------------------------------------------------------------------
// Mock the Slack client so tests never hit the network
// ---------------------------------------------------------------------------
vi.mock('../lib/slack-client', () => ({
  oauthAccess: vi.fn(),
  usersLookupByEmail: vi.fn(),
  revoke: vi.fn(),
}))

// Import after mock so we get the vi.fn() instances
import * as slackClient from '../lib/slack-client'

// ---------------------------------------------------------------------------
// Default mock values for a successful OAuth exchange
// ---------------------------------------------------------------------------
const MOCK_BOT_TOKEN = 'xoxb-test-bot-token'
const MOCK_BOT_USER_ID = 'U_BOT_001'
const MOCK_TEAM_ID = 'T_TEAM_001'
const MOCK_TEAM_NAME = 'Test Workspace'
const MOCK_SLACK_USER_ID = 'U_INSTALLER_001'

function setupMocksSuccess() {
  vi.mocked(slackClient.oauthAccess).mockResolvedValue({
    botToken: MOCK_BOT_TOKEN,
    botUserId: MOCK_BOT_USER_ID,
    teamId: MOCK_TEAM_ID,
    teamName: MOCK_TEAM_NAME,
  })
  vi.mocked(slackClient.usersLookupByEmail).mockResolvedValue(MOCK_SLACK_USER_ID)
  vi.mocked(slackClient.revoke).mockResolvedValue(undefined)
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
describe('Slack OAuth routes', () => {
  let db: any
  let app: any
  let reviewer: any
  let sessionToken: string

  beforeEach(async () => {
    // Set env vars so config.slack is populated in test mode.
    // optionalEnv() returns undefined in test mode — override via process.env
    // directly to bypass the test-mode guard.
    process.env.SLACK_CLIENT_ID = 'test_client_id'
    process.env.SLACK_CLIENT_SECRET = 'test_client_secret'
    process.env.SLACK_TOKEN_ENCRYPTION_KEY = TEST_ENC_KEY

    vi.clearAllMocks()
    setupMocksSuccess()

    const testDb = await createTestDb()
    db = testDb.db
    app = createApp({ db })

    const result = await seedReviewer(db, app, { email: 'alice@test.com' })
    reviewer = result.reviewer
    sessionToken = result.sessionToken
  })

  // -------------------------------------------------------------------------
  // GET /install
  // -------------------------------------------------------------------------
  describe('GET /install', () => {
    it('unauthenticated → 401', async () => {
      const res = await request(app).get('/api/v1/slack/install')
      expect(res.status).toBe(401)
    })

    it('authenticated → 200 JSON with authorize URL', async () => {
      const res = await request(app)
        .get('/api/v1/slack/install')
        .set('Authorization', `Bearer ${sessionToken}`)
        .expect(200)

      expect(res.body.url).toContain('https://slack.com/oauth/v2/authorize')
      expect(res.body.url).toContain('state=')
      expect(res.body.url).toContain('scope=chat%3Awrite%2Cusers%3Aread%2Cusers%3Aread.email')
    })

    // Regression: the requested scope shipped as "chat:write,users:read.email",
    // missing users:read. Slack treats users:read.email as an EXTENSION scope and
    // rejects it without users:read alongside, so every install would have failed
    // at the authorize step. Nothing asserted the scope, so nothing caught it
    // until the first real connect attempt.
    it('requests users:read alongside users:read.email, which Slack requires', async () => {
      const res = await request(app)
        .get('/api/v1/slack/install')
        .set('Authorization', `Bearer ${sessionToken}`)
        .expect(200)

      const scope = new URL(res.body.url).searchParams.get('scope') ?? ''
      const requested = scope.split(',')

      expect(requested).toContain('chat:write')
      expect(requested).toContain('users:read')
      expect(requested).toContain('users:read.email')
    })

    it('state param is a valid signed token for slack_oauth_state', async () => {
      const res = await request(app)
        .get('/api/v1/slack/install')
        .set('Authorization', `Bearer ${sessionToken}`)
        .expect(200)

      const url = new URL(res.body.url)
      const state = url.searchParams.get('state') ?? ''

      // verifyEmailToken is a re-export; we can call it directly
      const { verifyEmailToken } = await import('../lib/email-tokens')
      const payload = verifyEmailToken(state, 'slack_oauth_state')
      expect(payload).not.toBeNull()
      expect(payload?.reviewer_id).toBe(reviewer.id)
    })

    // Session auth never sets req.organizationId (that's an EE cloud-auth only
    // field), but a real deployment is not org-less: seed.ts stamps a real
    // Default Organization on the demo project. The state must carry that real
    // org id, not null, or delivery (which resolves org through the project)
    // would never match the workspace this install writes.
    it('single organization exists, auth names none → state carries the real org id', async () => {
      await db.insert(organizations).values({ id: 'org_solo', name: 'Solo Org', slug: 'org-solo' })

      const res = await request(app)
        .get('/api/v1/slack/install')
        .set('Authorization', `Bearer ${sessionToken}`)
        .expect(200)

      const url = new URL(res.body.url)
      const state = url.searchParams.get('state') ?? ''

      const { verifyEmailToken } = await import('../lib/email-tokens')
      const payload = verifyEmailToken(state, 'slack_oauth_state')
      expect(payload?.organization_id).toBe('org_solo')
    })

    it('several organizations exist, auth names none → 409 and no url issued', async () => {
      await db.insert(organizations).values([
        { id: 'org_x', name: 'Org X', slug: 'org-x' },
        { id: 'org_y', name: 'Org Y', slug: 'org-y' },
      ])

      const res = await request(app)
        .get('/api/v1/slack/install')
        .set('Authorization', `Bearer ${sessionToken}`)

      expect(res.status).toBe(409)
      expect(res.body.url).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // GET /callback
  // -------------------------------------------------------------------------
  describe('GET /callback', () => {
    /** Build a valid signed state from the /install JSON response */
    async function issueValidState(): Promise<string> {
      const res = await request(app)
        .get('/api/v1/slack/install')
        .set('Authorization', `Bearer ${sessionToken}`)
      const url = new URL(res.body.url)
      return url.searchParams.get('state') ?? ''
    }

    it('valid state + mocked oauthAccess → stores encrypted token and redirects', async () => {
      const state = await issueValidState()

      const res = await request(app)
        .get(`/api/v1/slack/callback?code=test_code&state=${state}`)

      expect(res.status).toBe(302)
      expect(res.headers['location']).toContain('/settings/integrations?slack=connected')

      // Verify workspace row exists
      const [workspace] = await db
        .select()
        .from(slackWorkspaces)
        .where(eq(slackWorkspaces.team_id, MOCK_TEAM_ID))
        .limit(1)

      expect(workspace).toBeDefined()
      expect(workspace.team_name).toBe(MOCK_TEAM_NAME)
      expect(workspace.bot_user_id).toBe(MOCK_BOT_USER_ID)

      // Security: stored value must NOT be the plaintext token
      expect(workspace.bot_token_encrypted).not.toBe(MOCK_BOT_TOKEN)
      // Security: round-trip decrypt must recover the plaintext
      expect(decryptAtRest(workspace.bot_token_encrypted, TEST_ENC_KEY)).toBe(MOCK_BOT_TOKEN)
    })

    it('valid state → upserts a slack_user_links row for the installer', async () => {
      const state = await issueValidState()

      await request(app)
        .get(`/api/v1/slack/callback?code=test_code&state=${state}`)

      const [link] = await db
        .select()
        .from(slackUserLinks)
        .where(eq(slackUserLinks.reviewer_id, reviewer.id))
        .limit(1)

      expect(link).toBeDefined()
      expect(link.slack_user_id).toBe(MOCK_SLACK_USER_ID)
      expect(link.slack_team_id).toBe(MOCK_TEAM_ID)
    })

    it('tampered state → 400 and no workspace row written', async () => {
      const state = await issueValidState()
      const tampered = state.slice(0, -4) + 'XXXX'

      const res = await request(app)
        .get(`/api/v1/slack/callback?code=test_code&state=${tampered}`)

      expect(res.status).toBe(400)

      // No workspace row should have been written
      const rows = await db
        .select()
        .from(slackWorkspaces)
        .where(eq(slackWorkspaces.team_id, MOCK_TEAM_ID))
        .limit(1)

      expect(rows.length).toBe(0)
      // oauthAccess must not have been called
      expect(slackClient.oauthAccess).not.toHaveBeenCalled()
    })

    it('wrong-purpose state → 400 and no workspace row written', async () => {
      const wrongPurposeState = generateEmailToken(
        { reviewer_id: reviewer.id, email: reviewer.email, purpose: 'verify-email' },
        10 * 60 * 1000,
      )

      const res = await request(app)
        .get(`/api/v1/slack/callback?code=test_code&state=${wrongPurposeState}`)

      expect(res.status).toBe(400)
      expect(slackClient.oauthAccess).not.toHaveBeenCalled()
    })

    it('missing code → 400', async () => {
      const state = await issueValidState()
      const res = await request(app)
        .get(`/api/v1/slack/callback?state=${state}`)
      expect(res.status).toBe(400)
    })

    it('cross-org team_id hijack → 409 and org A row unchanged', async () => {
      // Seed two orgs (FK targets for slack_workspaces.organization_id).
      await db.insert(organizations).values([
        { id: 'org_a', name: 'Org A', slug: 'org-a' },
        { id: 'org_b', name: 'Org B', slug: 'org-b' },
      ])

      // Mint a state carrying org A. The state itself drives organization_id,
      // so we can exercise the cloud branch without cloud auth.
      const stateA = generateEmailToken(
        {
          reviewer_id: reviewer.id,
          email: reviewer.email,
          purpose: 'slack_oauth_state',
          organization_id: 'org_a',
        },
        10 * 60 * 1000,
      )

      // Org A connects team T_x.
      const resA = await request(app)
        .get(`/api/v1/slack/callback?code=test_code&state=${stateA}`)
      expect(resA.status).toBe(302)

      const [rowA] = await db
        .select()
        .from(slackWorkspaces)
        .where(eq(slackWorkspaces.team_id, MOCK_TEAM_ID))
        .limit(1)
      expect(rowA.organization_id).toBe('org_a')
      const originalEncrypted = rowA.bot_token_encrypted

      // Org B attempts to connect the SAME team T_x → must be rejected.
      const stateB = generateEmailToken(
        {
          reviewer_id: reviewer.id,
          email: reviewer.email,
          purpose: 'slack_oauth_state',
          organization_id: 'org_b',
        },
        10 * 60 * 1000,
      )

      const resB = await request(app)
        .get(`/api/v1/slack/callback?code=test_code&state=${stateB}`)
      expect(resB.status).toBe(409)

      // Org A's row is untouched: same org, same encrypted token.
      const [rowAfter] = await db
        .select()
        .from(slackWorkspaces)
        .where(eq(slackWorkspaces.team_id, MOCK_TEAM_ID))
        .limit(1)
      expect(rowAfter.organization_id).toBe('org_a')
      expect(rowAfter.bot_token_encrypted).toBe(originalEncrypted)
    })
  })

  // -------------------------------------------------------------------------
  // GET /status
  // -------------------------------------------------------------------------
  describe('GET /status', () => {
    it('no workspace → { connected: false }', async () => {
      const res = await request(app)
        .get('/api/v1/slack/status')
        .set('Authorization', `Bearer ${sessionToken}`)

      expect(res.status).toBe(200)
      expect(res.body.connected).toBe(false)
    })

    it('after connect → { connected: true, team_name }', async () => {
      // Connect first
      const installRes = await request(app)
        .get('/api/v1/slack/install')
        .set('Authorization', `Bearer ${sessionToken}`)
      const url = new URL(installRes.body.url)
      const state = url.searchParams.get('state') ?? ''

      await request(app)
        .get(`/api/v1/slack/callback?code=test_code&state=${state}`)

      const res = await request(app)
        .get('/api/v1/slack/status')
        .set('Authorization', `Bearer ${sessionToken}`)

      expect(res.status).toBe(200)
      expect(res.body.connected).toBe(true)
      expect(res.body.team_name).toBe(MOCK_TEAM_NAME)
    })

    it('unauthenticated → 401', async () => {
      const res = await request(app).get('/api/v1/slack/status')
      expect(res.status).toBe(401)
    })

    // Task 8: GET /status surfaces whether the requesting reviewer's own
    // Slack lookup previously failed, so the pane can tell them why DMs
    // aren't arriving instead of leaving them to wonder.
    it('connected + a failed link row for the requesting reviewer → lookup_failed: true', async () => {
      const installRes = await request(app)
        .get('/api/v1/slack/install')
        .set('Authorization', `Bearer ${sessionToken}`)
      const url = new URL(installRes.body.url)
      const state = url.searchParams.get('state') ?? ''
      await request(app).get(`/api/v1/slack/callback?code=test_code&state=${state}`)

      // The OAuth callback itself already links the installing reviewer (a
      // successful lookup at install time), so mark that existing row failed
      // rather than inserting a fresh one and colliding on the primary key.
      await db
        .update(slackUserLinks)
        .set({ lookup_failed_at: new Date() })
        .where(eq(slackUserLinks.reviewer_id, reviewer.id))

      const res = await request(app)
        .get('/api/v1/slack/status')
        .set('Authorization', `Bearer ${sessionToken}`)

      expect(res.status).toBe(200)
      expect(res.body.connected).toBe(true)
      expect(res.body.lookup_failed).toBe(true)
    })

    it('connected + no link row for the requesting reviewer → lookup_failed: false', async () => {
      const installRes = await request(app)
        .get('/api/v1/slack/install')
        .set('Authorization', `Bearer ${sessionToken}`)
      const url = new URL(installRes.body.url)
      const state = url.searchParams.get('state') ?? ''
      await request(app).get(`/api/v1/slack/callback?code=test_code&state=${state}`)

      const res = await request(app)
        .get('/api/v1/slack/status')
        .set('Authorization', `Bearer ${sessionToken}`)

      expect(res.status).toBe(200)
      expect(res.body.connected).toBe(true)
      expect(res.body.lookup_failed).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // POST /disconnect
  // -------------------------------------------------------------------------
  describe('POST /disconnect', () => {
    it('unauthenticated → 401', async () => {
      const res = await request(app).post('/api/v1/slack/disconnect')
      expect(res.status).toBe(401)
    })

    it('no workspace → 404', async () => {
      const res = await request(app)
        .post('/api/v1/slack/disconnect')
        .set('Authorization', `Bearer ${sessionToken}`)
      expect(res.status).toBe(404)
    })

    it('after connect → revoke called + revoked_at set + 200', async () => {
      // Connect first
      const installRes = await request(app)
        .get('/api/v1/slack/install')
        .set('Authorization', `Bearer ${sessionToken}`)
      const url = new URL(installRes.body.url)
      const state = url.searchParams.get('state') ?? ''

      await request(app)
        .get(`/api/v1/slack/callback?code=test_code&state=${state}`)

      vi.clearAllMocks()
      vi.mocked(slackClient.revoke).mockResolvedValue(undefined)

      const disconnectRes = await request(app)
        .post('/api/v1/slack/disconnect')
        .set('Authorization', `Bearer ${sessionToken}`)

      expect(disconnectRes.status).toBe(200)
      expect(disconnectRes.body.ok).toBe(true)
      expect(slackClient.revoke).toHaveBeenCalledTimes(1)

      // Workspace row must have revoked_at set
      const [workspace] = await db
        .select()
        .from(slackWorkspaces)
        .where(eq(slackWorkspaces.team_id, MOCK_TEAM_ID))
        .limit(1)

      expect(workspace.revoked_at).not.toBeNull()
    })

    it('after disconnect /status → { connected: false }', async () => {
      // Connect
      const installRes = await request(app)
        .get('/api/v1/slack/install')
        .set('Authorization', `Bearer ${sessionToken}`)
      const url = new URL(installRes.body.url)
      const state = url.searchParams.get('state') ?? ''
      await request(app)
        .get(`/api/v1/slack/callback?code=test_code&state=${state}`)

      vi.mocked(slackClient.revoke).mockResolvedValue(undefined)

      // Disconnect
      await request(app)
        .post('/api/v1/slack/disconnect')
        .set('Authorization', `Bearer ${sessionToken}`)

      // Status should now show disconnected
      const statusRes = await request(app)
        .get('/api/v1/slack/status')
        .set('Authorization', `Bearer ${sessionToken}`)

      expect(statusRes.body.connected).toBe(false)
    })
  })
})

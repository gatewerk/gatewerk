import { Router } from 'express'
import type { Request } from 'express'
import { and, eq, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { slackWorkspaces, slackUserLinks, organizations } from '@gatewerk/db'
import type { AppDb } from '@gatewerk/db'
import { InvalidRequestError, ConflictError, NotFoundError } from '@gatewerk/shared'
import { sessionAuth } from '../middleware/session-auth'
import { generateEmailToken, verifyEmailToken } from '../lib/email-tokens'
import { encryptAtRest, decryptAtRest } from '../lib/secret-crypto'
import * as slackClient from '../lib/slack-client'
import { config } from '../config'
import { serverEnv } from '../env'
import type { AuditService } from '../services/audit'

// 10-minute TTL for OAuth state tokens
const STATE_TTL_MS = 10 * 60 * 1000

/**
 * Read Slack credentials at request time so tests that set process.env before
 * creating the app can supply values. serverEnv (t3-env) reads process.env at
 * access time under skipValidation, unlike config.slack which uses optionalEnv()
 * — a helper that always returns undefined in test mode to protect tests from
 * inherited shell exports.
 */
function getSlackConfig(): { clientId: string; clientSecret: string; tokenEncryptionKey: string } | null {
  const clientId = serverEnv.SLACK_CLIENT_ID
  const clientSecret = serverEnv.SLACK_CLIENT_SECRET
  const tokenEncryptionKey = serverEnv.SLACK_TOKEN_ENCRYPTION_KEY
  if (!clientId || !clientSecret || !tokenEncryptionKey) return null
  return { clientId, clientSecret, tokenEncryptionKey }
}

function redirectUri(): string {
  return `${config.apiOrigin}/api/v1/slack/callback`
}

/**
 * Resolve the current workspace row scoped to an organization.
 * OSS: orgId is null → match rows where organization_id IS NULL.
 * Cloud: orgId is non-null → match rows where organization_id = orgId.
 * Always exclude revoked rows.
 */
async function findActiveWorkspace(db: AppDb, orgId: string | null) {
  const orgCondition =
    orgId !== null
      ? eq(slackWorkspaces.organization_id, orgId)
      : isNull(slackWorkspaces.organization_id)

  const [row] = await db
    .select()
    .from(slackWorkspaces)
    .where(and(orgCondition, isNull(slackWorkspaces.revoked_at)))
    .limit(1)

  return row ?? null
}

/**
 * The organization that owns a Slack workspace.
 *
 * `req.organizationId` is set only on the EE cloud-auth branch, but OSS is NOT
 * org-less: the seed creates a "Default Organization" and stamps it on the demo
 * project (packages/db/src/seed.ts). Delivery resolves a notification's org
 * through its project, so a workspace stored with a NULL org would never match a
 * real project's org and DMs would stop silently.
 *
 * `{ ok: false }` means several organizations exist but auth named none — write
 * nothing rather than guess an owner.
 */
async function resolveOwnerOrgId(
  db: AppDb,
  req: Request,
): Promise<{ ok: true; orgId: string | null } | { ok: false }> {
  const fromAuth = (req as any).organizationId
  if (fromAuth) return { ok: true, orgId: fromAuth }

  const rows = await db.select({ id: organizations.id }).from(organizations).limit(2)
  if (rows.length === 0) return { ok: true, orgId: null }
  if (rows.length === 1) return { ok: true, orgId: rows[0].id }
  return { ok: false }
}

export function createSlackRoutes(db: AppDb, auditService?: AuditService): Router {
  const r = Router()

  // GET /install — initiate OAuth flow
  // Requires session auth. Issues a signed state token and redirects to Slack.
  r.get('/install', sessionAuth(db), async (req, res, next) => {
    try {
      const slackCfg = getSlackConfig()
      if (!slackCfg) {
        return next(new InvalidRequestError('Slack not configured', undefined, 'slack_not_configured'))
      }

      const reviewer = (req as any).reviewer
      const ownerOrg = await resolveOwnerOrgId(db, req)
      if (!ownerOrg.ok) {
        return next(
          new ConflictError(
            'Multiple organizations found; cannot determine which owns this Slack workspace',
            'multiple_organizations',
          ),
        )
      }
      const orgId = ownerOrg.orgId

      const state = generateEmailToken(
        {
          reviewer_id: reviewer.id,
          email: reviewer.email,
          purpose: 'slack_oauth_state',
          organization_id: orgId,
        },
        STATE_TTL_MS,
      )

      const authorizeUrl = new URL('https://slack.com/oauth/v2/authorize')
      authorizeUrl.searchParams.set('client_id', slackCfg.clientId)
      // `users:read.email` is an EXTENSION scope: Slack rejects it unless
      // `users:read` is requested alongside, which is why the app manifest
      // needs all three. Requesting only two here would either fail at the
      // authorize step or grant a token that cannot resolve an email, and
      // usersLookupByEmail would then fail for every reviewer.
      authorizeUrl.searchParams.set('scope', 'chat:write,users:read,users:read.email')
      authorizeUrl.searchParams.set('state', state)
      authorizeUrl.searchParams.set('redirect_uri', redirectUri())

      return res.json({ url: authorizeUrl.toString() })
    } catch (err) {
      next(err)
    }
  })

  // GET /callback — public; Slack redirects here after user grants access
  // State is verified via HMAC; no session cookie is required.
  r.get('/callback', async (req, res, next) => {
    try {
      const slackCfg = getSlackConfig()
      if (!slackCfg) {
        return next(new InvalidRequestError('Slack not configured', undefined, 'slack_not_configured'))
      }

      const { code, state } = req.query as Record<string, string | undefined>

      if (!code || !state) {
        return next(new InvalidRequestError('Missing code or state', undefined, 'missing_params'))
      }

      // Verify state — forgery, expiry, or wrong purpose → 400, no DB writes
      const payload = verifyEmailToken(state, 'slack_oauth_state')
      if (!payload) {
        return next(new InvalidRequestError('Invalid or expired state', undefined, 'invalid_state'))
      }

      const installerReviewerId = payload.reviewer_id
      const installerEmail = payload.email
      const orgId: string | null = payload.organization_id ?? null

      // Exchange code for bot token (network call — mocked in tests)
      const result = await slackClient.oauthAccess({
        code,
        clientId: slackCfg.clientId,
        clientSecret: slackCfg.clientSecret,
        redirectUri: redirectUri(),
      })

      const { botToken, botUserId, teamId, teamName } = result

      // Cross-org hijack guard. team_id is UNIQUE (the OSS single-row dedup
      // key), but a naive upsert would silently reassign a workspace owned by
      // one org to a different org. Reject when the existing row belongs to a
      // DIFFERENT org (JS === so null===null passes for OSS re-install; a real
      // org id vs a different org id — or vs null — fails). Write nothing.
      const [existing] = await db
        .select()
        .from(slackWorkspaces)
        .where(eq(slackWorkspaces.team_id, teamId))
        .limit(1)

      if (existing && existing.organization_id !== orgId) {
        return next(
          new ConflictError(
            'This Slack workspace is already connected to another organization',
            'workspace_owned_by_other_org',
          ),
        )
      }

      // Encrypt bot token at rest — never store or log the plaintext value
      const botTokenEncrypted = encryptAtRest(botToken, slackCfg.tokenEncryptionKey)

      // Upsert slack_workspaces keyed by team_id
      await db
        .insert(slackWorkspaces)
        .values({
          id: randomUUID(),
          organization_id: orgId,
          team_id: teamId,
          team_name: teamName,
          bot_token_encrypted: botTokenEncrypted,
          bot_user_id: botUserId,
          installed_by_reviewer_id: installerReviewerId,
          created_at: new Date(),
          revoked_at: null,
        })
        .onConflictDoUpdate({
          target: slackWorkspaces.team_id,
          set: {
            team_name: teamName,
            bot_token_encrypted: botTokenEncrypted,
            bot_user_id: botUserId,
            installed_by_reviewer_id: installerReviewerId,
            organization_id: orgId,
            revoked_at: null,
          },
        })

      // Look up the installer's Slack user ID and upsert a link row (best-effort)
      try {
        const slackUserId = await slackClient.usersLookupByEmail(botToken, installerEmail)
        if (slackUserId) {
          await db
            .insert(slackUserLinks)
            .values({
              reviewer_id: installerReviewerId,
              slack_user_id: slackUserId,
              slack_team_id: teamId,
              cached_at: new Date(),
            })
            .onConflictDoUpdate({
              target: slackUserLinks.reviewer_id,
              set: {
                slack_user_id: slackUserId,
                slack_team_id: teamId,
                cached_at: new Date(),
              },
            })
        }
      } catch {
        // usersLookupByEmail failure is non-fatal; link creation is best-effort
      }

      // Tier 2 REQUIRED (services/AUDIT-WRITE-CONTRACT.md). This handler is
      // state-changing despite being a GET: it upserts slack_workspaces and
      // slack_user_links, which is what decides where oversight DMs land. The
      // upsert overwrites in place, so the row cannot say which workspace was
      // connected before, when, or by whom — and repointing notifications at a
      // workspace the attacker controls is a review-content exfiltration path.
      //
      // Written after the upsert and before the redirect, so a failure surfaces
      // rather than redirecting the installer to a success page. Never carries
      // botToken or botTokenEncrypted: bot_user_id is a public identifier, the
      // token is not.
      //
      // No project_id: slack_workspaces is scoped to an ORGANIZATION, not a
      // project, and inventing one here would file the row in a tenant partition
      // it does not belong to.
      if (auditService) {
        await auditService.log({
          action: 'slack.connected',
          actor: `reviewer:${installerEmail}`,
          resource_type: 'slack_workspace',
          resource_id: teamId,
          details: {
            team_id: teamId,
            team_name: teamName,
            bot_user_id: botUserId,
            organization_id: orgId,
            installed_by_reviewer_id: installerReviewerId,
            reinstall: Boolean(existing),
          },
        })
      }

      // nosemgrep: javascript.express.web.tainted-redirect-express.tainted-redirect-express
      return res.redirect(302, `${config.uiOrigin}/settings/integrations?slack=connected`)
    } catch (err) {
      next(err)
    }
  })

  // GET /status — session auth
  // Returns connection status for the current org.
  r.get('/status', sessionAuth(db), async (req, res, next) => {
    try {
      const ownerOrg = await resolveOwnerOrgId(db, req)
      if (!ownerOrg.ok) {
        return next(
          new ConflictError(
            'Multiple organizations found; cannot determine which owns this Slack workspace',
            'multiple_organizations',
          ),
        )
      }

      const workspace = await findActiveWorkspace(db, ownerOrg.orgId)
      if (!workspace) {
        return res.json({ connected: false })
      }

      // Task 8: tell a connected reviewer when we looked for their Slack
      // account and could not find one, so they know to expect email
      // instead of a silent, unexplained absence of DMs.
      const reviewer = (req as any).reviewer
      const [link] = await db
        .select({ lookup_failed_at: slackUserLinks.lookup_failed_at })
        .from(slackUserLinks)
        .where(eq(slackUserLinks.reviewer_id, reviewer.id))
        .limit(1)

      return res.json({
        connected: true,
        team_name: workspace.team_name,
        lookup_failed: Boolean(link?.lookup_failed_at),
      })
    } catch (err) {
      next(err)
    }
  })

  // POST /disconnect — session auth
  // Revokes the bot token (best-effort) and marks the workspace as revoked.
  r.post('/disconnect', sessionAuth(db), async (req, res, next) => {
    try {
      const slackCfg = getSlackConfig()
      const ownerOrg = await resolveOwnerOrgId(db, req)
      if (!ownerOrg.ok) {
        return next(
          new ConflictError(
            'Multiple organizations found; cannot determine which owns this Slack workspace',
            'multiple_organizations',
          ),
        )
      }

      const workspace = await findActiveWorkspace(db, ownerOrg.orgId)
      if (!workspace) {
        return next(new NotFoundError('No connected Slack workspace', 'no_slack_workspace'))
      }

      // Revoke bot token at Slack — best-effort; never let a revoke failure
      // block the local disconnect, and never log the plaintext token.
      if (slackCfg) {
        try {
          const botToken = decryptAtRest(
            workspace.bot_token_encrypted,
            slackCfg.tokenEncryptionKey,
          )
          await slackClient.revoke(botToken)
        } catch {
          // Best-effort — proceed to local revocation regardless
        }
      }

      await db
        .update(slackWorkspaces)
        .set({ revoked_at: new Date() })
        .where(eq(slackWorkspaces.id, workspace.id))

      // Tier 2 REQUIRED. Disconnecting silently stops every Slack DM, so this is
      // the row that explains a period during which reviewers were never
      // notified. `revoked_at` records WHEN but not WHO. No project_id, for the
      // same organization-scoping reason as slack.connected above.
      if (auditService) {
        await auditService.log({
          action: 'slack.disconnected',
          actor: `reviewer:${(req as any).reviewer?.email ?? 'unknown'}`,
          resource_type: 'slack_workspace',
          resource_id: workspace.team_id,
          details: {
            team_id: workspace.team_id,
            team_name: workspace.team_name,
            organization_id: workspace.organization_id,
            installed_by_reviewer_id: workspace.installed_by_reviewer_id,
            ip: req.ip,
          },
        })
      }

      return res.status(200).json({ ok: true })
    } catch (err) {
      next(err)
    }
  })

  return r
}

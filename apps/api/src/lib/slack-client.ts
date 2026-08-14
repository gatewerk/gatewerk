/**
 * Raw-fetch Slack Web API client.
 *
 * Dependency-free: uses the global `fetch` only — no @slack/* packages.
 * All inputs are accepted as plain parameters so the module is trivially
 * testable by replacing global.fetch with a mock.
 *
 * Error convention: throws new Error('slack_' + body.error) when
 * body.ok === false, EXCEPT usersLookupByEmail which returns null on
 * error === 'users_not_found'.
 */

const SLACK_API = 'https://slack.com/api'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function slackPost(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init)
  const body = (await res.json()) as Record<string, unknown>
  return body
}

function throwSlackError(body: Record<string, unknown>): never {
  throw new Error('slack_' + String(body['error'] ?? 'unknown'))
}

// ---------------------------------------------------------------------------
// oauthAccess
// ---------------------------------------------------------------------------

export interface OAuthAccessParams {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
}

export interface OAuthAccessResult {
  botToken: string
  botUserId: string
  teamId: string
  teamName: string
}

/**
 * Exchanges an OAuth authorization code for a bot token.
 *
 * Endpoint: POST https://slack.com/api/oauth.v2.access
 * Encoding: application/x-www-form-urlencoded (client credentials in body)
 */
export async function oauthAccess(params: OAuthAccessParams): Promise<OAuthAccessResult> {
  const body = new URLSearchParams({
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
  })

  const res = await slackPost(`${SLACK_API}/oauth.v2.access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (res['ok'] !== true) {
    throwSlackError(res)
  }

  const team = res['team'] as { id: string; name: string }

  return {
    botToken: res['access_token'] as string,
    botUserId: res['bot_user_id'] as string,
    teamId: team.id,
    teamName: team.name,
  }
}

// ---------------------------------------------------------------------------
// usersLookupByEmail
// ---------------------------------------------------------------------------

/**
 * Looks up a Slack user by email address.
 *
 * Returns the Slack user ID string on success, or null when the user is
 * not found (Slack error: users_not_found). Throws on any other error.
 *
 * Endpoint: POST https://slack.com/api/users.lookupByEmail
 * Encoding: application/x-www-form-urlencoded; authenticated via Bearer token.
 */
export async function usersLookupByEmail(
  botToken: string,
  email: string,
): Promise<string | null> {
  const body = new URLSearchParams({ email })

  const res = await slackPost(`${SLACK_API}/users.lookupByEmail`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${botToken}`,
    },
    body: body.toString(),
  })

  if (res['ok'] !== true) {
    if (res['error'] === 'users_not_found') {
      return null
    }
    throwSlackError(res)
  }

  const user = res['user'] as { id: string }
  return user.id
}

// ---------------------------------------------------------------------------
// postMessage
// ---------------------------------------------------------------------------

/**
 * Posts a message to a Slack channel or user DM.
 *
 * When `channel` is a Slack user ID (e.g. "U123ABC"), Slack implicitly
 * opens (or reuses) the DM conversation with that user.
 *
 * Endpoint: POST https://slack.com/api/chat.postMessage
 * Encoding: application/json; authenticated via Bearer token.
 */
export async function postMessage(
  botToken: string,
  channel: string,
  blocks: unknown[],
  text: string,
): Promise<void> {
  const res = await slackPost(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, blocks, text }),
  })

  if (res['ok'] !== true) {
    throwSlackError(res)
  }
}

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

/**
 * Revokes (invalidates) a bot token.
 *
 * Endpoint: POST https://slack.com/api/auth.revoke
 * Authenticated via Bearer token; no additional body required.
 */
export async function revoke(botToken: string): Promise<void> {
  const res = await slackPost(`${SLACK_API}/auth.revoke`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
    },
  })

  if (res['ok'] !== true) {
    throwSlackError(res)
  }
}

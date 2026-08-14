# @gatewerk/mcp

The Gatewerk MCP server lets AI agents read and decide reviews from inside Claude Desktop, Claude Code, Cursor, Windsurf, or any [Model Context Protocol](https://modelcontextprotocol.io/) client. It exposes Gatewerk's review/template/feedback/audit/chain/note APIs as MCP tools, scoped to whatever permissions the API key carries.

[Gatewerk](https://gatewerk.com) is an open-source, self-hosted review layer for AI agents. Work done for humans is decided by humans.

## Quickstart

```bash
npx @gatewerk/mcp init
```

The `init` command prompts for your Gatewerk URL, API key, and (optionally) reviewer email, then prints a config block you paste into your MCP client's settings.

You can also write the config by hand:

```json
{
  "mcpServers": {
    "gatewerk": {
      "command": "npx",
      "args": ["-y", "@gatewerk/mcp@1.1.0"],
      "env": {
        "GATEWERK_URL": "https://api.gatewerk.com",
        "GATEWERK_API_KEY": "gwk_...",
        "GATEWERK_REVIEWER": "alice@team.com"
      }
    }
  }
}
```

`GATEWERK_REVIEWER` is optional — when set, decisions made through the MCP server are attributed to that reviewer. Otherwise the API key's identity is used.

## Available tools

Tools are filtered automatically based on the scopes attached to your API key. A key with only `reviews:read` will not see `gatewerk_decide_review`.

### Reviews

- `gatewerk_create_review` — submit a new review request (scope: `reviews:create`)
- `gatewerk_list_reviews` — list reviews with filters (scope: `reviews:read`)
- `gatewerk_get_review` — fetch a review with its template metadata (scope: `reviews:read`)
- `gatewerk_decide_review` — approve / reject / edit / retry a review [deprecated; prefer `gatewerk_take_review_action`] (scope: `reviews:decide`)
- `gatewerk_take_review_action` — invoke a configurable action on a review; supports built-in and template-specific action IDs (scope: `reviews:decide`)
- `gatewerk_list_review_actions` — introspect the available actions on a review's template (scope: `reviews:read`)

### Templates

- `gatewerk_list_templates` — list templates (scope: `templates:read`)
- `gatewerk_create_template` — define a template (scope: `templates:write`)
- `gatewerk_update_template` — modify a template (scope: `templates:write`)
- `gatewerk_delete_template` — remove a template (scope: `templates:write`)

### Chains

- `gatewerk_start_chain_run` — start a multi-step review chain from a definition (scope: `templates:write`)
- `gatewerk_get_chain_run` — fetch a chain run + steps by ID (scope: `reviews:read`)
- `gatewerk_get_chain_for_review` — get chain context for a review (scope: `reviews:read`)

### Notes

- `gatewerk_create_note` — post a note, optionally pinned to one or more reviews/templates/chain runs (scope: `notes:write`)
- `gatewerk_list_notes` — list notes with filters (author, tags, target, shared/private) (scope: `notes:read`)

### Queries + stats

- `gatewerk_query_feedback` — query past decisions for learning (scope: `feedback:read`)
- `gatewerk_query_audit` — query the audit trail (scope: `audit:read`)
- `gatewerk_get_stats` — review metrics + daily trend (scope: `stats:read`)

## Authentication

You'll need a Gatewerk API key with the appropriate scopes. Generate one at:

- Cloud: [https://app.gatewerk.com](https://app.gatewerk.com) → Settings → API Keys
- Self-hosted: your Gatewerk instance's `/settings/api-keys` page

Common scope bundles:

- **agent** (read your reviews + create new ones): `reviews:create`, `feedback:read`
- **reviewer** (act on the inbox): `reviews:read`, `reviews:decide`, `templates:read`, `notes:read`, `notes:write`
- **admin** (full surface): all scopes

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GATEWERK_API_KEY` | yes | API key (`gwk_...`) |
| `GATEWERK_URL` | no | Gatewerk base URL (defaults to `http://localhost:3100`) |
| `GATEWERK_REVIEWER` | no | Reviewer email used as decision attribution |

## Links

- Website: [https://gatewerk.com](https://gatewerk.com)
- App: [https://app.gatewerk.com](https://app.gatewerk.com)
- Source: [https://github.com/gatewerk/gatewerk](https://github.com/gatewerk/gatewerk)
- Docs: [https://gatewerk.com/docs](https://gatewerk.com/docs)
- License: Apache-2.0 (MCP SDK package; server is AGPL-3.0-only)

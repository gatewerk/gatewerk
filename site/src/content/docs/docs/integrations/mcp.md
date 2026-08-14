---
title: MCP integration
description: Connect Claude Code, Claude Desktop, Cursor, or Windsurf to Gatewerk so AI agents can create and decide reviews as MCP tool calls.
---

The Gatewerk MCP server exposes your Gatewerk instance as a set of MCP tools that any Model Context Protocol client can call. An AI agent running in Claude Code, Claude Desktop, Cursor, or Windsurf can create a review, wait for a human decision, and read the result: all without leaving the coding session.

## How do I install it?

```bash
npx @gatewerk/mcp init
```

The init command prompts for your Gatewerk URL, API key, and (optionally) a reviewer email, then prints a config block to paste into your MCP client settings.

## How do I configure it?

Set these environment variables in your MCP client config:

| Variable | Required | Description |
|---|---|---|
| `GATEWERK_API_KEY` | yes | API key (`gwk_...`) |
| `GATEWERK_URL` | no | Gatewerk base URL (defaults to `http://localhost:3100`) |
| `GATEWERK_REVIEWER` | no | Email used as decision attribution when the MCP server decides a review |

**Claude Code**: add to `.claude/mcp.json` or your user-level `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "gatewerk": {
      "command": "npx",
      "args": ["-y", "@gatewerk/mcp@latest"],
      "env": {
        "GATEWERK_URL": "http://localhost:3100",
        "GATEWERK_API_KEY": "$GATEWERK_API_KEY"
      }
    }
  }
}
```

**Claude Desktop**: add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "gatewerk": {
      "command": "npx",
      "args": ["-y", "@gatewerk/mcp@latest"],
      "env": {
        "GATEWERK_URL": "http://localhost:3100",
        "GATEWERK_API_KEY": "gwk_..."
      }
    }
  }
}
```

**Cursor**: add to `.cursor/mcp.json` in your project root or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "gatewerk": {
      "command": "npx",
      "args": ["-y", "@gatewerk/mcp@latest"],
      "env": {
        "GATEWERK_URL": "http://localhost:3100",
        "GATEWERK_API_KEY": "gwk_..."
      }
    }
  }
}
```

**Windsurf**: add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "gatewerk": {
      "command": "npx",
      "args": ["-y", "@gatewerk/mcp@latest"],
      "env": {
        "GATEWERK_URL": "http://localhost:3100",
        "GATEWERK_API_KEY": "gwk_..."
      }
    }
  }
}
```

For hosted or remote deployments, replace `http://localhost:3100` with your instance's API URL.

## How do I gate my first action?

After configuring the server, ask your AI agent to create a review through MCP. Here is the tool call the agent makes:

```
gatewerk_create_review(
  template = "email-review",
  payload = {
    "to": "ceo@acme.com",
    "subject": "Q4 Report",
    "body": "Please find the Q4 report attached."
  },
  priority = "normal"
)
```

The tool returns a review object with an `id` and `status: "pending"`. The review appears in the Gatewerk Inbox. A human approves, rejects, or edits it there. The agent can then call `gatewerk_get_review` to read the settled decision.

## How does the decision come back?

`gatewerk_get_review` returns the full review once a human acts on it:

```
gatewerk_get_review(id = "gw_rev_...")
```

The result includes:

- `decision`: values include `"approved"`, `"rejected"`, `"edited"`, `"retried"`, `"expired"`, and others; see [The gate](/docs/concepts/the-gate) for the full enum
- `approved_value`: the payload the human approved (post-edit, if any)
- `feedback`: free-text note from the reviewer

The agent reads this result and decides what to do next. No webhook plumbing required on the agent side.

## What else can it do?

Tools are filtered automatically based on the scopes on your API key. A key with `reviews:create` and `feedback:read` (agent bundle) sees only the tools it needs: `gatewerk_create_review` and `gatewerk_query_feedback`. A reviewer-scoped key additionally sees `gatewerk_list_reviews`, `gatewerk_get_review`, `gatewerk_take_review_action`, `gatewerk_list_review_actions`, and the notes tools.

### Reviews

| Tool | Required scope |
|---|---|
| `gatewerk_create_review` | `reviews:create` |
| `gatewerk_list_reviews` | `reviews:read` |
| `gatewerk_get_review` | `reviews:read` |
| `gatewerk_list_review_actions` | `reviews:read` |
| `gatewerk_take_review_action` | `reviews:decide` |
| `gatewerk_decide_review` | `reviews:decide` (deprecated; prefer `gatewerk_take_review_action`) |

### Templates

| Tool | Required scope |
|---|---|
| `gatewerk_list_templates` | `templates:read` |
| `gatewerk_create_template` | `templates:write` |
| `gatewerk_update_template` | `templates:write` |
| `gatewerk_delete_template` | `templates:write` |

### Chains

| Tool | Required scope |
|---|---|
| `gatewerk_start_chain_run` | `templates:write` |
| `gatewerk_get_chain_run` | `reviews:read` |
| `gatewerk_get_chain_for_review` | `reviews:read` |

### Notes

| Tool | Required scope |
|---|---|
| `gatewerk_create_note` | `notes:write` |
| `gatewerk_list_notes` | `notes:read` |

### Queries and stats

| Tool | Required scope |
|---|---|
| `gatewerk_query_feedback` | `feedback:read` |
| `gatewerk_query_audit` | `audit:read` |
| `gatewerk_get_stats` | `stats:read` |

**Scope bundles**: when generating an API key, these presets cover the common cases:

- **agent**: `reviews:create`, `feedback:read`. The agent can open gates and read past decisions for learning. It cannot read or decide other reviews.
- **reviewer**: `reviews:read`, `reviews:decide`, `templates:read`, `notes:read`, `notes:write`. Enough for a human acting through MCP to manage the Inbox.
- **admin**: all scopes. Full surface access.

---

See also: [Quickstart](/docs/quickstart), [The gate](/docs/concepts/the-gate), [Decisions and webhooks](/docs/concepts/decisions-and-webhooks)

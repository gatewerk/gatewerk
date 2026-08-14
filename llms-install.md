# Gatewerk MCP Server — Automated Installer Guide

> File exists for automated installers (Cline, MCP registries, AI agents).

Gatewerk is the open-source review layer for AI agents.

Work done for humans is decided by humans.

## Prerequisites

Need a running instance. Two paths:

**A — Existing instance:** You have `GATEWERK_URL` and an API key. Skip to Install.

**B — Local (fresh start):**
```bash
git clone https://github.com/gatewerk/gatewerk.git && cd gatewerk
./scripts/quickstart.sh   # starts Postgres + API on localhost:3100; prints API key
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GATEWERK_API_KEY` | **yes** | API key (`gwk_...`) |
| `GATEWERK_URL` | no | Instance URL (default `http://localhost:3100`) |
| `GATEWERK_REVIEWER` | no | Email for decision attribution |

## Install

**Claude Code** — `.claude/mcp.json` or `~/.claude/mcp.json`:
```json
{ "mcpServers": { "gatewerk": { "command": "npx", "args": ["-y", "@gatewerk/mcp@latest"],
  "env": { "GATEWERK_URL": "http://localhost:3100", "GATEWERK_API_KEY": "$GATEWERK_API_KEY" } } } }
```

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{ "mcpServers": { "gatewerk": { "command": "npx", "args": ["-y", "@gatewerk/mcp@latest"],
  "env": { "GATEWERK_URL": "http://localhost:3100", "GATEWERK_API_KEY": "gwk_..." } } } }
```

**Cursor** — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):
```json
{ "mcpServers": { "gatewerk": { "command": "npx", "args": ["-y", "@gatewerk/mcp@latest"],
  "env": { "GATEWERK_URL": "http://localhost:3100", "GATEWERK_API_KEY": "gwk_..." } } } }
```

## Get an API Key

- **Quickstart:** printed to terminal on first run.
- **Running instance:** Settings → API Keys → New Key → scope bundle **agent**.

## Verify

Call `gatewerk_list_templates()`. Expect 6 starter templates on a fresh instance.
If empty, confirm the instance is seeded and the key has `templates:read` scope.

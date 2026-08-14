---
title: Install (production)
description: Take the same Docker Compose stack from the quickstart to a real production deployment on your own domain.
---

The [quickstart](/docs/quickstart) gets Gatewerk running on your machine in under ten minutes using the same `docker-compose.yml` you will use in production. This page covers the additional configuration needed to run that stack on a real server with your own domain and TLS.

## What does the stack consist of?

Five services, started in strict order:

| Service | Role | Start condition |
|---|---|---|
| `gatewerk-db` | PostgreSQL 16 database — the sole persistence layer | Health probe: `pg_isready` |
| `gatewerk-migrate` | One-shot migration runner — applies any pending SQL files and exits | `gatewerk-db` healthy |
| `gatewerk-seed` | One-shot seed runner — creates the default org, project, and API key on first boot | `gatewerk-migrate` completed successfully |
| `gatewerk-api` | Express/Bun API on port 3100 | `gatewerk-seed` completed successfully |
| `gatewerk-web` | Nginx serving the compiled React dashboard on port 8880 | `gatewerk-api` healthy |

The `service_completed_successfully` conditions mean the API never starts on a broken schema: if a migration fails, the deploy fails fast and the prior image keeps running.

## How do I configure it for production?

The `.env` file at the repository root controls the stack. For production you need the four required secrets plus the two domain variables:

```bash
# Required secrets — generate with: openssl rand -hex 32
POSTGRES_PASSWORD=<random hex>
JWT_SECRET=<random hex>
HMAC_SECRET=<random hex>
OTP_HMAC_SECRET=<random hex>

# Point these at your real domains
UI_ORIGIN=https://app.example.com
VITE_API_URL=https://api.example.com
```

**Why four separate secrets?**

- `JWT_SECRET`: signs reviewer session tokens. Rotating it invalidates all active sessions.
- `HMAC_SECRET`: signs outbound webhook payloads (Standard Webhooks v1). Rotating it breaks in-flight webhook signature verification for integrations.
- `OTP_HMAC_SECRET`: signs email OTP codes for external review links. Kept separate so rotating session signing never invalidates outstanding review links, and vice versa.
- `POSTGRES_PASSWORD`: the bundled Postgres container credential. Compartmentalized so a leaked DB password does not expose any application signing key.

Each domain has its own blast radius. A leaked `JWT_SECRET` does not compromise webhook signatures or OTP links.

**Reverse proxy and TLS.** Run nginx, Caddy, or Traefik in front of the two exposed ports (8880 for the dashboard, 3100 for the API). Terminate TLS at the proxy and forward `http://localhost:8880` and `http://localhost:3100` respectively. The `UI_ORIGIN` value is used for CORS validation, so it must exactly match the `Origin` your browser sends: include the scheme and omit any trailing slash. The compose file does not handle TLS itself.

## What are the security defaults?

The `gatewerk-api` container ships hardened out of the box: no operator action required:

- `read_only: true`: the container filesystem is mounted read-only; only `/tmp` and the uploads volume are writable.
- `cap_drop: [ALL]`: all Linux capabilities are dropped.
- `no-new-privileges:true`: the process cannot escalate privileges via setuid/setgid.
- `tmpfs: [/tmp]`: temporary files go to an in-memory volume, not disk.

Secrets are injected at runtime via environment variables and are never baked into the Docker image. The image build context excludes the `.env` file.

**After first boot:** change the seeded admin password (`admin@gatewerk.local` / `admin123`). The dashboard prompts you on first login, or go to **Settings** → **Account** → **Change password**.

## Can I scale it horizontally?

Not with the default compose. The architecture is deliberately single-instance:

- The API-key rate limiter is an in-process `Map`: limits multiply by instance count and reset on restart.
- The SSE hub and ticket store are in-process: a ticket issued by instance A is unknown to instance B, so real-time inbox updates break.
- The OSS email rate limiter is in-process.
- The `EventBus` is in-process: SSE fan-out reaches only clients on the emitting process.

The database workers (timeout, webhook retry) are multi-instance safe via pg-boss claims. The API itself is stateless beyond the four in-process components above.

For higher load, scale vertically (more CPU/RAM on the same host) and run one API instance. The code comments identify the Redis-swap points for a future horizontal tier.

## Where next?

- [SMTP configuration](/docs/self-hosting/smtp): enable notification emails and external review links
- [Backups](/docs/self-hosting/backups): what to back up and how
- [Upgrades](/docs/self-hosting/upgrades): applying new versions and migrations

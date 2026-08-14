# @gatewerk/site

The gatewerk.com marketing and documentation site — one Astro 7 + Starlight build that serves both the marketing pages (landing, pricing, licensing, roadmap) at the root and the `/docs` tree via Starlight.

## Commands

```bash
# Development server
pnpm --filter @gatewerk/site dev

# Production build
pnpm --filter @gatewerk/site build

# Preview the production build locally
pnpm --filter @gatewerk/site preview
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PUBLIC_POSTHOG_KEY` | No | — | PostHog project token. Analytics render nothing when absent; builds are green either way. |
| `PUBLIC_POSTHOG_HOST` | No | `https://eu.i.posthog.com` | PostHog ingest host. Override to use US region (`https://us.i.posthog.com`) or a self-hosted instance. |

Analytics are cookieless (`persistence: "memory"`, `autocapture: false`, `respect_dnt: true`). No consent banner is required.

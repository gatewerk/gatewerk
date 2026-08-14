# Licensing

Gatewerk is open source. Different parts carry different licenses, each chosen
for how that part is used.

## The short version

| Part | License | Why |
|------|---------|-----|
| The server and dashboard (`apps/api`, `apps/web-next`, and their private packages `packages/db`, `packages/emails`, `packages/web-core`) | **AGPL-3.0-only** | Strong copyleft. Run it, self-host it, modify it freely. If you modify it and offer it to others as a network service, you share your changes back. |
| The client libraries (`packages/sdk-ts`, `packages/sdk-py`, `packages/mcp`, `packages/shared`) | **Apache-2.0** | Permissive. You embed these in your own agents and integrations, so they carry no copyleft obligation. Build whatever you want on top. |
| The n8n community node package (`packages/n8n-nodes-gatewerk`) | **MIT** | Permissive. MIT is required by n8n's verified-node program for community-published integrations. |
| The `ee/` submodule | **Proprietary** | Commercial features, in a separate private repository. Not covered by the open-source licenses above, and not present in a normal clone of this repo. |

Full license texts: `LICENSE` (AGPL-3.0) at the repository root, a
per-package `LICENSE` (Apache-2.0) inside each client library except the n8n
community node package, which carries a per-package `LICENSE` (MIT).

## What this means for you

**Self-hosting Gatewerk for your own use is unrestricted.** Running it inside
your company, modified or not, for your own agents, carries no obligation to
publish anything. The AGPL only asks you to share changes if you take a
modified server and offer *it* to other people as a service.

**Building on the SDKs is unrestricted.** The client libraries are Apache-2.0,
so you can import them into closed-source agents and products with no strings
attached.

**If your organization's policy does not permit AGPL software,** a commercial
license of the server is available. Reach out and we will sort it out.

## Contributing

We are not yet accepting external contributions to the AGPL-licensed server.
When we open that up, a lightweight contributor agreement will be in place
first. Until then, issues and discussion are very welcome.

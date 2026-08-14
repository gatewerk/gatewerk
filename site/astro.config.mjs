import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightDotMd from "starlight-dot-md";
import { posthogSnippet } from "./src/lib/posthog-snippet.mjs";
import { QUIET_MODE } from "./src/quiet-mode.ts";

const phKey = process.env.PUBLIC_POSTHOG_KEY;
const phHost = process.env.PUBLIC_POSTHOG_HOST || "https://eu.i.posthog.com";

// Warm brand fonts for the docs (Starlight) — the marketing layout loads these
// for its own pages, but Starlight renders its own <head>, so it needs them too.
// Bricolage (display/headings), Hanken (body), JetBrains Mono (code).
const fontHead = [
  { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
  { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true } },
  {
    tag: "link",
    attrs: {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
    },
  },
];

const starlightHead = [
  // PNG favicon fallback for browsers that ignore SVG icons (Safari).
  { tag: "link", attrs: { rel: "icon", href: "/favicon-32.png", type: "image/png", sizes: "32x32" } },
  ...fontHead,
  ...(phKey ? [{ tag: "script", content: posthogSnippet(phKey, phHost) }] : []),
];

export default defineConfig({
  site: "https://gatewerk.com",
  trailingSlash: "never",
  integrations: [
    starlight({
      title: "Gatewerk",
      description: "Open source human review for AI agents. Human judgment enters the pipeline, exactly where you choose.",
      head: starlightHead,
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/gatewerk/gatewerk" }],
      editLink: { baseUrl: "https://github.com/gatewerk/gatewerk/edit/master/site/" },
      customCss: ["./src/styles/global.css"],
      components: {
        ThemeProvider: "./src/components/ForceDarkTheme.astro",
        ThemeSelect: "./src/components/EmptyThemeSelect.astro",
      },
      plugins: [
        starlightLlmsTxt({
          projectName: "Gatewerk",
          description: "Open source human review for AI agents. Human judgment enters the pipeline, exactly where you choose.",
          // The two bullets below name docs/quickstart.md specifically. The
          // starlightDotMd() excludePatterns below drops that raw-markdown
          // route while QUIET_MODE is on, so promoting it here would point
          // agents at a 404. Omit just those two bullets in that case; the
          // rest of the block, and this block entirely once QUIET_MODE is
          // false, stays byte-identical to what shipped before this gate.
          details: `Work done for humans is decided by humans.

## Instructions for AI agents

${[
            ...(QUIET_MODE
              ? []
              : [
                  "- Every documentation page is available as raw markdown: append `.md` to its URL (e.g. https://gatewerk.com/docs/quickstart.md).",
                  "- The quickstart at https://gatewerk.com/docs/quickstart.md is completable end-to-end by an agent: clone, run ./scripts/quickstart.sh, obtain an API key from the seed logs, create a review with POST /api/v1/reviews, decide it with POST /api/v1/reviews/{id}/action.",
                ]),
            "- The full OpenAPI 3.1 specification is at https://gatewerk.com/openapi.json.",
            "- Gatewerk is self-hosted: the base URL in examples is the operator's own deployment.",
          ].join("\n")}`,
          optionalLinks: [
            {
              label: "Quickstart",
              url: "https://gatewerk.com/docs/quickstart.md",
              description: "run Gatewerk with Docker Compose and decide a first review in under ten minutes",
            },
            {
              label: "MCP integration (Claude Code, Cursor, Windsurf)",
              url: "https://gatewerk.com/docs/integrations/mcp.md",
              description: "connect any MCP client to Gatewerk so AI agents can create and decide reviews as tool calls",
            },
            {
              label: "REST API guide",
              url: "https://gatewerk.com/docs/integrations/rest.md",
              description: "create reviews, poll for decisions, and invoke actions over plain HTTP with any client",
            },
            {
              label: "Self-hosting install",
              url: "https://gatewerk.com/docs/self-hosting/install.md",
              description: "production deployment on your own domain with Docker Compose, TLS, and secrets",
            },
            {
              label: "HRP protocol",
              url: "https://gatewerk.com/docs/protocol/hrp.md",
              description: "the open Agent-to-Human communication specification that Gatewerk implements",
            },
            {
              label: "LangGraph human in the loop",
              url: "https://gatewerk.com/docs/guides/langgraph-human-in-the-loop.md",
              description: "how interrupt() works in LangGraph, what it gives you, and what a dedicated review station adds",
            },
          ].filter((link) => !(QUIET_MODE && link.url === "https://gatewerk.com/docs/quickstart.md")),
        }),
        // quickstart.mdx wraps its cloud-trial sentence in a QUIET_MODE
        // conditional for the rendered page, but this plugin's raw .md
        // passthrough serves the file's unevaluated source (entry.body),
        // so the JSX and the hidden sentence would leak verbatim through
        // /docs/quickstart.md — a URL llms.txt promotes to agents. Exclude
        // that one slug from the raw export while quiet mode is on; it
        // comes back automatically when QUIET_MODE flips to false.
        starlightDotMd({
          excludePatterns: QUIET_MODE ? ["docs/quickstart"] : [],
        }),
      ],
      sidebar: [
        { label: "Getting started", items: [{ label: "Quickstart", slug: "docs/quickstart" }] },
        { label: "Concepts", items: [
          { label: "The gate", slug: "docs/concepts/the-gate" },
          { label: "Templates", slug: "docs/concepts/templates" },
          { label: "Decisions and webhooks", slug: "docs/concepts/decisions-and-webhooks" },
        ]},
        { label: "Advanced", collapsed: true, items: [
          { label: "Iteration", slug: "docs/advanced/iteration" },
          { label: "Chains", slug: "docs/advanced/chains" },
          { label: "Assignment ladder", slug: "docs/advanced/assignment-ladder" },
          { label: "External review", slug: "docs/advanced/external-review" },
          { label: "Monitoring", slug: "docs/advanced/monitoring" },
          { label: "Notes", slug: "docs/advanced/notes" },
          { label: "Feedback memory", slug: "docs/advanced/feedback-memory" },
        ]},
        { label: "Guides", items: [
          { label: "LangGraph human in the loop", slug: "docs/guides/langgraph-human-in-the-loop" },
          { label: "n8n: wait for human approval", slug: "docs/guides/n8n-wait-for-human-approval" },
          { label: "Add approval to an AI agent", slug: "docs/guides/ai-agent-approval-workflow" },
        ]},
        { label: "Integrations", items: [
          { label: "MCP (Claude Code / Desktop / Cursor / Windsurf)", slug: "docs/integrations/mcp" },
          { label: "n8n", slug: "docs/integrations/n8n" },
          { label: "Python SDK", slug: "docs/integrations/python" },
          { label: "LangGraph", slug: "docs/integrations/langgraph" },
          { label: "TypeScript SDK", slug: "docs/integrations/typescript" },
          { label: "CrewAI", slug: "docs/integrations/crewai" },
          { label: "REST API", slug: "docs/integrations/rest" },
        ]},
        { label: "Self-hosting", items: [
          { label: "Install (production)", slug: "docs/self-hosting/install" },
          { label: "SMTP", slug: "docs/self-hosting/smtp" },
          { label: "Backups", slug: "docs/self-hosting/backups" },
          { label: "Upgrades", slug: "docs/self-hosting/upgrades" },
        ]},
        {
          label: "Reference",
          items: [
            { label: "API reference", link: "/api-reference" },
            { label: "HRP protocol", slug: "docs/protocol/hrp" },
          ],
        },
      ],
    }),
    sitemap(),
  ],
  vite: { plugins: [tailwindcss()] },
});

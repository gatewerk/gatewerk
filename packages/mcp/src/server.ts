import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json" with { type: "json" };
import { createClient } from "gatewerk";
import type { ClientConfig } from "gatewerk";
import type { ToolDefinition } from "./types.js";
import { reviewTools } from "./tools/reviews.js";
import { templateTools } from "./tools/templates.js";
import { queryTools } from "./tools/queries.js";
import { statsTools } from "./tools/stats.js";
import { chainTools } from "./tools/chains.js";
import { noteTools } from "./tools/notes.js";

export interface McpServerConfig extends ClientConfig {
  reviewer?: string;
}

function getAllTools(client: ReturnType<typeof createClient>, reviewer?: string): ToolDefinition[] {
  return [
    ...reviewTools(client, reviewer),
    ...templateTools(client),
    ...queryTools(client),
    ...statsTools(client),
    ...chainTools(client),
    ...noteTools(client),
  ];
}

function filterByScopes(tools: ToolDefinition[], scopes: string[]): ToolDefinition[] {
  return tools.filter((tool) => scopes.includes(tool.scope));
}

export async function createGatewerkMcpServer(config: McpServerConfig) {
  const client = createClient(config);
  const baseUrl = (config.url || process.env.GATEWERK_URL || "http://localhost:3100").replace(/\/+$/, "");

  // Fetch key scopes for tool filtering. The filter only trims the tool
  // list the client sees; the API enforces scopes on every call. So an
  // unreachable instance degrades to exposing all tools instead of
  // refusing to start — hosting platforms probe the server without a
  // live Gatewerk behind it. A definitive auth rejection still fails
  // fast: a bad key would turn every tool call into an error.
  let res: Response | undefined;
  try {
    res = await fetch(`${baseUrl}/api/v1/auth/key-info`, {
      headers: {
        Authorization: `Bearer ${config.apiKey || process.env.GATEWERK_API_KEY}`,
        "Content-Type": "application/json",
      },
    });
  } catch {
    console.error(
      `Gatewerk MCP: Cannot connect to Gatewerk at ${baseUrl} — exposing all tools; the API enforces key scopes on every call.`,
    );
  }

  // null scopes = a full-access key; skip filtering entirely.
  let scopes: string[] | null = null;
  if (res) {
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error("Invalid API key. Check GATEWERK_API_KEY.");
      }
      throw new Error(`Cannot fetch key info: ${res.status} ${res.statusText}`);
    }
    const keyInfo = await res.json() as { scopes: string[] | null };
    scopes = keyInfo.scopes;
  }

  const allTools = getAllTools(client, config.reviewer);
  const tools = scopes ? filterByScopes(allTools, scopes) : allTools;

  if (tools.length === 0) {
    throw new Error("API key has no scopes that map to MCP tools. Check key permissions in Gatewerk dashboard.");
  }

  const server = new McpServer({
    name: "gatewerk",
    // Read from package.json rather than a literal. This was hardcoded "1.1.0"
    // and had already drifted: @gatewerk/mcp 1.1.1 was on npm reporting 1.1.0
    // to every client's initialize response, which is the one place a user can
    // see which server version they are actually talking to. init.ts already
    // derives its pinned npx version the same way.
    version: (pkg as { version: string }).version,
  });

  // Register filtered tools
  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema,
      async (params) => tool.handler(params) as any,
    );
  }

  const scopeInfo = !res ? "unfiltered, instance unreachable" : scopes ? scopes.join(", ") : "all (full access)";
  console.error(`Gatewerk MCP: registered ${tools.length}/${allTools.length} tools (scopes: ${scopeInfo})`);

  return server;
}

// Export for testing
export { getAllTools, filterByScopes };

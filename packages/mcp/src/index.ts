#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGatewerkMcpServer } from "./server.js";

const args = process.argv.slice(2);

if (args[0] === "init") {
  const { runInit } = await import("./init.js");
  await runInit();
} else {
  const url = process.env.GATEWERK_URL || "http://localhost:3100";
  const apiKey = process.env.GATEWERK_API_KEY;
  const reviewer = process.env.GATEWERK_REVIEWER;

  if (!apiKey) {
    console.error("Error: GATEWERK_API_KEY is required. Set it in your MCP server config.");
    process.exit(1);
  }

  const transportMode = process.env.GATEWERK_MCP_TRANSPORT === "http" ? "http" : "stdio";

  try {
    const server = await createGatewerkMcpServer({ url, apiKey, reviewer });

    if (transportMode === "http") {
      const { startHttpTransport } = await import("./transport-http.js");
      const host = process.env.GATEWERK_MCP_HOST || "127.0.0.1";
      const port = Number(process.env.GATEWERK_MCP_PORT) || 3200;
      await startHttpTransport(server, { host, port });
    } else {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

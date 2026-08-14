import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface HttpTransportOptions {
  host: string;
  port: number;
}

const MCP_PATH = "/mcp";

// SECURITY: this endpoint has no authentication of its own. Anyone who can
// reach it can call every tool the configured GATEWERK_API_KEY has access
// to, i.e. it acts AS that API key. It must stay bound to loopback unless
// you have already restricted access at the network layer (e.g. it is only
// reachable from other containers on a private, non-internet-facing Docker
// network). Never bind this to 0.0.0.0 on a host with a public interface.
export async function startHttpTransport(server: McpServer, options: HttpTransportOptions): Promise<void> {
  const { host, port } = options;

  // Host header allowlist for DNS-rebinding protection: a browser tricked
  // into resolving an attacker-controlled hostname to 127.0.0.1 would still
  // send that hostname in the Host header, which this rejects.
  const allowedHosts = Array.from(new Set([`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`]));

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: true,
    allowedHosts,
  });

  // One McpServer, connected once, shared across every HTTP request for the
  // life of the process — the same tool-registration path used by stdio.
  await server.connect(transport);

  const httpServer = createServer((req, res) => {
    const path = req.url?.split("?")[0];
    if (path !== MCP_PATH) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(
        JSON.stringify({ error: `Not found. The Gatewerk MCP endpoint is ${MCP_PATH}.` }),
      );
      return;
    }

    transport.handleRequest(req, res).catch((err) => {
      console.error(`Gatewerk MCP: request error: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  console.error(`Gatewerk MCP: listening on http://${host}:${port}${MCP_PATH} (transport: streamable-http, loopback only unless GATEWERK_MCP_HOST is overridden)`);
}

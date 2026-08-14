import { createInterface } from "readline/promises";
import pkg from "../package.json" with { type: "json" };

// Pin the npx invocation to this package's published version so agents'
// generated configs reproduce the version they tested with. Distribution
// strategy spec §4.14 — MCP registry submissions need version-pinned
// quickstart snippets so consumers don't get a different surface than the
// one they validated.
const PACKAGE_VERSION = (pkg as { version: string }).version;

export type Target = "claude-code" | "claude-desktop" | "cursor" | "json";

interface InitInput {
  url: string;
  apiKey: string;
  reviewer: string;
  target: Target;
}

export function generateConfig(input: InitInput): string {
  const env: Record<string, string> = {
    GATEWERK_URL: input.url,
    GATEWERK_API_KEY: input.apiKey,
  };

  if (input.reviewer) {
    env.GATEWERK_REVIEWER = input.reviewer;
  }

  const serverConfig = {
    command: "npx",
    args: ["-y", `@gatewerk/mcp@${PACKAGE_VERSION}`],
    env,
  };

  const config = {
    mcpServers: {
      gatewerk: serverConfig,
    },
  };

  return JSON.stringify(config, null, 2);
}

export async function runInit() {
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  try {
    const url = (await rl.question("Gatewerk URL (default: http://localhost:3100): ")).trim() || "http://localhost:3100";
    const apiKey = (await rl.question("API Key: ")).trim();

    if (!apiKey) {
      console.error("Error: API key is required.");
      process.exit(1);
    }

    const reviewer = (await rl.question("Reviewer email (optional): ")).trim();

    console.error("\nTarget:");
    console.error("  1) Claude Code");
    console.error("  2) Claude Desktop");
    console.error("  3) Cursor");
    console.error("  4) JSON only");
    const targetChoice = (await rl.question("Choose (1-4, default 1): ")).trim() || "1";

    const targetMap: Record<string, Target> = {
      "1": "claude-code",
      "2": "claude-desktop",
      "3": "cursor",
      "4": "json",
    };
    const target = targetMap[targetChoice] || "claude-code";

    const config = generateConfig({ url, apiKey, reviewer, target });

    console.error("\n--- Copy this into your settings ---\n");
    console.log(config);
    console.error("\n--- End config ---");
  } finally {
    rl.close();
  }
}

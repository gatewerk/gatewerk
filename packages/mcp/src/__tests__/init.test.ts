import { describe, it, expect } from "vitest";
import { generateConfig } from "../init.js";
import pkg from "../../package.json" with { type: "json" };

describe("generateConfig", () => {
  const baseInput = {
    url: "http://localhost:3100",
    apiKey: "ck_test123",
    reviewer: "alice@team.com",
  };

  it("generates Claude Code config with version-pinned npx args", () => {
    const config = generateConfig({ ...baseInput, target: "claude-code" });
    const parsed = JSON.parse(config);
    expect(parsed.mcpServers.gatewerk.command).toBe("npx");
    expect(parsed.mcpServers.gatewerk.args).toEqual(["-y", `@gatewerk/mcp@${pkg.version}`]);
    // Sanity: must not be unpinned `@gatewerk/mcp` — that's the regression
    // we're guarding against (consumers picking up a future major-version
    // surface that may break their tested integration).
    expect(parsed.mcpServers.gatewerk.args[1]).not.toBe("@gatewerk/mcp");
    expect(parsed.mcpServers.gatewerk.args[1]).toMatch(/^@gatewerk\/mcp@\d+\.\d+\.\d+/);
    expect(parsed.mcpServers.gatewerk.env.GATEWERK_URL).toBe("http://localhost:3100");
    expect(parsed.mcpServers.gatewerk.env.GATEWERK_API_KEY).toBe("ck_test123");
    expect(parsed.mcpServers.gatewerk.env.GATEWERK_REVIEWER).toBe("alice@team.com");
  });

  it("generates Claude Desktop config", () => {
    const config = generateConfig({ ...baseInput, target: "claude-desktop" });
    const parsed = JSON.parse(config);
    expect(parsed.mcpServers.gatewerk.command).toBe("npx");
  });

  it("generates Cursor config", () => {
    const config = generateConfig({ ...baseInput, target: "cursor" });
    const parsed = JSON.parse(config);
    expect(parsed.mcpServers.gatewerk.command).toBe("npx");
  });

  it("generates JSON-only config", () => {
    const config = generateConfig({ ...baseInput, target: "json" });
    const parsed = JSON.parse(config);
    expect(parsed.mcpServers.gatewerk).toBeDefined();
  });

  it("omits GATEWERK_REVIEWER when empty", () => {
    const config = generateConfig({ ...baseInput, reviewer: "", target: "json" });
    const parsed = JSON.parse(config);
    expect(parsed.mcpServers.gatewerk.env.GATEWERK_REVIEWER).toBeUndefined();
  });

  it("omits GATEWERK_URL when default", () => {
    const config = generateConfig({ ...baseInput, target: "json" });
    const parsed = JSON.parse(config);
    // Default URL should still be included for explicitness
    expect(parsed.mcpServers.gatewerk.env.GATEWERK_URL).toBe("http://localhost:3100");
  });
});

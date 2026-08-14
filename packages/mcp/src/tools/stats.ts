import type { GatewerkClient } from "gatewerk";
import type { ToolDefinition } from "../types.js";
import { toolSuccess, toolError } from "../types.js";

export function statsTools(client: GatewerkClient): ToolDefinition[] {
  return [
    {
      name: "gatewerk_get_stats",
      description: "View review metrics: total count, breakdown by status/decision, average review time, per-template counts, and daily trend (last 30 days).",
      scope: "stats:read",
      schema: {},
      handler: async () => {
        const { data, error } = await client.stats.get();
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
  ];
}

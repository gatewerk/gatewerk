import type { Result } from "../errors.js";
import { success, failure } from "../errors.js";

export class StatsResource {
  constructor(
    private baseUrl: string,
    private headers: () => Record<string, string>,
  ) {}

  async get(): Promise<Result<Record<string, unknown>>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/stats`, {
        method: "GET",
        headers: this.headers(),
      });
      const body = await res.json();

      if (!res.ok) {
        const apiError = body.error || {};
        return failure({
          type: apiError.type || "api_error",
          code: apiError.code || "unknown",
          message: apiError.message || `Request failed with status ${res.status}`,
          statusCode: res.status,
        });
      }

      return success(body);
    } catch (err) {
      return failure({
        type: "network_error",
        code: "network_error",
        message: err instanceof Error ? err.message : "Network error",
        statusCode: 0,
      });
    }
  }
}

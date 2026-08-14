import type { Result } from "../errors.js";
import { success, failure } from "../errors.js";

export interface FeedbackFilters {
  template?: string;
  outcome?: string;
  limit?: number;
  offset?: number;
}

export class FeedbackResource {
  constructor(
    private baseUrl: string,
    private headers: () => Record<string, string>,
  ) {}

  async query(filters?: FeedbackFilters): Promise<Result<Record<string, unknown>>> {
    const params = new URLSearchParams();
    if (filters?.template) params.set("template", filters.template);
    if (filters?.outcome) params.set("outcome", filters.outcome);
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));

    const qs = params.toString();
    const url = `${this.baseUrl}/api/v1/feedback${qs ? `?${qs}` : ""}`;

    try {
      const res = await fetch(url, { method: "GET", headers: this.headers() });
      const body = await res.json();

      if (!res.ok) {
        const apiError = body.error || {};
        return {
          data: null,
          error: {
            type: apiError.type || "api_error",
            code: apiError.code || "unknown",
            message: apiError.message || `Request failed with status ${res.status}`,
            statusCode: res.status,
          },
        };
      }

      return success(body);
    } catch (err) {
      return {
        data: null,
        error: {
          type: "network_error",
          code: "network_error",
          message: err instanceof Error ? err.message : "Network error",
          statusCode: 0,
        },
      };
    }
  }
}

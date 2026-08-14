import type { Result } from "../errors.js";
import { success, failure } from "../errors.js";

export interface AuditFilters {
  action?: string;
  resource_type?: string;
  resource_id?: string;
  actor?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  // Wave 2: GET /api/v1/audit accepts ?project_id (apps/api/src/routes/audit.ts).
  // For api_key callers it must match req.projectId (otherwise 403 cross-tenant);
  // for session callers it scopes the audit query to a specific project on
  // multi-project deployments.
  project_id?: string;
}

export class AuditResource {
  constructor(
    private baseUrl: string,
    private headers: () => Record<string, string>,
  ) {}

  async query(filters?: AuditFilters): Promise<Result<Record<string, unknown>>> {
    const params = new URLSearchParams();
    if (filters?.action) params.set("action", filters.action);
    if (filters?.resource_type) params.set("resource_type", filters.resource_type);
    if (filters?.resource_id) params.set("resource_id", filters.resource_id);
    if (filters?.actor) params.set("actor", filters.actor);
    if (filters?.from) params.set("from", filters.from);
    if (filters?.to) params.set("to", filters.to);
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
    if (filters?.project_id) params.set("project_id", filters.project_id);

    const qs = params.toString();
    const url = `${this.baseUrl}/api/v1/audit${qs ? `?${qs}` : ""}`;

    try {
      const res = await fetch(url, { method: "GET", headers: this.headers() });
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

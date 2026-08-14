import type { Result } from "../errors.js";
import { success, failure } from "../errors.js";

export interface CreateTemplateInput {
  slug: string;
  name: string;
  description?: string;
  fields: Array<{
    name: string;
    type: string;
    label: string;
    readonly?: boolean;
    editable?: boolean;
    options?: string[];
  }>;
  actions: string[];
  default_priority?: string;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string;
  fields?: CreateTemplateInput["fields"];
  actions?: string[];
  default_priority?: string;
}

export class TemplatesResource {
  constructor(
    private baseUrl: string,
    private headers: () => Record<string, string>,
  ) {}

  private async request<T>(url: string, init?: RequestInit): Promise<Result<T>> {
    try {
      const res = await fetch(url, { ...init, headers: { ...this.headers(), ...init?.headers } });
      const body = await res.json();

      if (!res.ok) {
        const apiError = body.error || {};
        return failure<T>({
          type: apiError.type || "api_error",
          code: apiError.code || "unknown",
          message: apiError.message || `Request failed with status ${res.status}`,
          statusCode: res.status,
        });
      }

      return success<T>(body);
    } catch (err) {
      return failure<T>({
        type: "network_error",
        code: "network_error",
        message: err instanceof Error ? err.message : "Network error",
        statusCode: 0,
      });
    }
  }

  async list(): Promise<Result<Record<string, unknown>>> {
    return this.request(`${this.baseUrl}/api/v1/templates`, { method: "GET" });
  }

  async get(id: string): Promise<Result<Record<string, unknown>>> {
    return this.request(`${this.baseUrl}/api/v1/templates/${id}`, { method: "GET" });
  }

  async create(input: CreateTemplateInput): Promise<Result<Record<string, unknown>>> {
    return this.request(`${this.baseUrl}/api/v1/templates`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async update(id: string, input: UpdateTemplateInput): Promise<Result<Record<string, unknown>>> {
    return this.request(`${this.baseUrl}/api/v1/templates/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  async delete(id: string): Promise<Result<Record<string, unknown>>> {
    return this.request(`${this.baseUrl}/api/v1/templates/${id}`, {
      method: "DELETE",
    });
  }
}

import { getToken } from "./client/http";

export interface AuditEvent {
  id: string;
  action: string;
  actor: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
  object: "audit_event";
}

interface AuditListResponse {
  object: "list";
  items: AuditEvent[];
  has_more: boolean;
  total: number;
}

const EMPTY_RESPONSE: AuditListResponse = {
  object: "list",
  items: [],
  has_more: false,
  total: 0,
};

export interface ListAuditParams {
  resource_id?: string;
  resource_type?: string;
  /** A single action, or several to match any of — sent as repeated
   *  `action=` query params (the route's Express side already parses
   *  repeated keys into an array). */
  action?: string | string[];
  /** ISO instants, not bare dates — the caller resolves a picked calendar
   *  day to its own local start/end-of-day before sending it here. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

// Uses raw fetch instead of request() because a 401/403 from the audit
// endpoint must NOT clear the session token or redirect to login. The
// audit scope is admin-only; non-admin users get an empty result instead
// of a session-killing cascade.
export const audit = {
  list: async (params: ListAuditParams = {}): Promise<AuditListResponse> => {
    const qs = new URLSearchParams();
    if (params.resource_id) qs.set("resource_id", params.resource_id);
    if (params.resource_type) qs.set("resource_type", params.resource_type);
    if (params.action) {
      const actions = Array.isArray(params.action) ? params.action : [params.action];
      for (const a of actions) qs.append("action", a);
    }
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    const q = qs.toString();

    const token = getToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    try {
      const res = await fetch(`/api/v1/audit${q ? `?${q}` : ""}`, { headers });
      if (!res.ok) return EMPTY_RESPONSE;
      return await res.json();
    } catch {
      return EMPTY_RESPONSE;
    }
  },
};

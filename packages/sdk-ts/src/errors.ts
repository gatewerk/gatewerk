/**
 * Structured error returned by the Gatewerk API.
 *
 * Notable `code` values for the monitoring oversight axis:
 *
 * Creation-time refusals (POST /reviews with oversight "monitoring"):
 *   - monitoring_requires_reversible
 *   - monitoring_not_supported_for_chains
 *   - monitoring_not_enabled_for_template
 *   - monitoring_conflicts_with_auto_approve
 *   - monitoring_requires_callback_url
 *   - monitoring_forbids_timeout_action (note: Zod schema validation usually
 *     fires first for this case, surfacing a generic validation error at
 *     path timeout.action)
 *   - monitoring_requires_timeout
 *   - monitoring_forbids_assignment_ladder
 *
 * Veto/Confirm endpoint errors (POST /reviews/:id/veto | /confirm):
 *   - human_actor_required (403 — api-key callers)
 *   - window_closed (409)
 *   - review_already_decided (409)
 *   - review_not_monitoring (409)
 *   - review_not_found (404)
 *
 * Guard-surface codes agents may also meet:
 *   - use_monitoring_endpoints (legacy /decide with confirmed/vetoed)
 *   - monitoring_requires_veto_or_confirm (action pipeline + DELETE)
 *   - monitoring_not_snoozable
 *   - monitoring_not_shareable
 */
export interface GatewerkApiError {
  type: string;
  code: string;
  message: string;
  statusCode: number;
  param?: string;
  doc_url?: string;
}

export type Result<T> = { data: T; error: null } | { data: null; error: GatewerkApiError };

export function success<T>(data: T): Result<T> {
  return { data, error: null };
}

export function failure<T>(error: GatewerkApiError): Result<T> {
  return { data: null, error };
}

import { InvalidRequestError } from "@gatewerk/shared";
import type { ReviewCreateBody } from "@gatewerk/shared";

// HOTL monitoring gate — creation-time eligibility.
// Every failure is a loud, machine-readable 4xx. NEVER downgrade to blocking:
// a silent downgrade lets a non-checking agent act while the review blocks,
// recreating the dishonest DIY pattern this feature exists to kill.
//
// v1 decision (spec §4.1): the callback URL must come from the request body.
// There is NO API-key fallback — `(req as any).defaultCallbackUrl` is dead
// code (read once in crud.ts, never set by any middleware), and the URL that
// satisfies this gate is persisted into reviews.callback_url by create(),
// which is the column every webhook dispatch path reads.
export interface MonitoringGateTemplate {
  allow_monitoring: boolean;
  auto_approve: boolean;
  timeout_seconds: number | null;
  chain_config: unknown | null;
}

export function assertMonitoringEligibility(
  body: Pick<ReviewCreateBody, "irreversibility" | "callback_url" | "timeout" | "assignment_ladder">,
  tpl: MonitoringGateTemplate,
): void {
  if (body.irreversibility !== "reversible") {
    throw new InvalidRequestError(
      "Monitoring gates require irreversibility to be exactly 'reversible'. Label the action reversible only if it can genuinely be undone; otherwise use a blocking gate. Support for costly_reversible is tracked for a later release.",
      "irreversibility",
      "monitoring_requires_reversible",
    );
  }
  if (tpl.chain_config) {
    throw new InvalidRequestError(
      "Monitoring gates are not supported on chain templates in v1. Chain steps stay blocking; see the design doc for the Point 2 deferral.",
      "template",
      "monitoring_not_supported_for_chains",
    );
  }
  if (!tpl.allow_monitoring) {
    throw new InvalidRequestError(
      "This template does not allow monitoring gates. A human must enable 'Allow monitoring gates' on the template first.",
      "template",
      "monitoring_not_enabled_for_template",
    );
  }
  if (tpl.auto_approve) {
    throw new InvalidRequestError(
      "This template auto approves reviews, which contradicts a veto window. Disable auto approve on the template or use a blocking gate.",
      "template",
      "monitoring_conflicts_with_auto_approve",
    );
  }
  if (!body.callback_url) {
    throw new InvalidRequestError(
      "Monitoring gates require a callback_url: the veto signal has nowhere to go without one, which would make the Veto button pure theater.",
      "callback_url",
      "monitoring_requires_callback_url",
    );
  }
  // Zod already rejects timeout.action for monitoring; this is route-layer
  // defense-in-depth mirroring the trace_url pattern in crud.ts.
  if (body.timeout?.action !== undefined) {
    throw new InvalidRequestError(
      "timeout.action is not allowed for monitoring gates; the window auto confirms on silence.",
      "timeout",
      "monitoring_forbids_timeout_action",
    );
  }
  const effectiveSeconds = body.timeout?.seconds ?? tpl.timeout_seconds;
  if (!effectiveSeconds) {
    throw new InvalidRequestError(
      "Monitoring gates require a veto window: supply timeout.seconds or set a timeout default on the template.",
      "timeout",
      "monitoring_requires_timeout",
    );
  }
  if (body.assignment_ladder && body.assignment_ladder.length > 0) {
    throw new InvalidRequestError(
      "assignment_ladder cannot be combined with a monitoring gate: ladder promotion never fires inside a veto window, which would be a silent no-op. Use a plain assignee.",
      "assignment_ladder",
      "monitoring_forbids_assignment_ladder",
    );
  }
}

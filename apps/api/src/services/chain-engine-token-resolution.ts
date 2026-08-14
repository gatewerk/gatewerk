import type { ChainDefinitionStep } from "@gatewerk/shared";
import type { templates } from "@gatewerk/db/src/schema/index";

// Chain step external_token resolution (§13).
//
// Pure helper extracted from chain-engine.ts to keep that file under the
// 600 LOC hard cap.
//
// Override chain: assignee fields take precedence over template defaults,
// which take precedence over the hardcoded `public` fallback. Mirrors the
// manual share-via-link UI (apps/web/.../ShareViaLinkDialog) so chain
// authors see consistent semantics across surfaces.
//
// PII-as-type-absence: this resolver returns nullable auth_email /
// auth_user_id but the chain audit emit at chain-engine.ts MUST NOT
// surface those fields. auth_level is operator-set and safe to surface.

export interface ResolvedTokenInputs {
  auth_level: "public" | "email_otp" | "account";
  auth_email: string | null;
  auth_user_id: string | null;
  recipient_label: string;
  purpose: string;
  expiryHours: number;
}

const DEFAULT_EXPIRY_SECONDS_FALLBACK = 604800; // 7 days, default fallback when neither assignee nor template provides expiry

function isAuthLevel(value: string): value is "public" | "email_otp" | "account" {
  return value === "public" || value === "email_otp" || value === "account";
}

export function resolveChainTokenInputs(
  stepDefinition: ChainDefinitionStep,
  template: typeof templates.$inferSelect,
): ResolvedTokenInputs {
  if (stepDefinition.assignee.kind !== "external_token") {
    throw new Error(
      "resolveChainTokenInputs called with non-external_token assignee — " +
        "callers must check stepDefinition.assignee.kind first",
    );
  }
  const a = stepDefinition.assignee;

  // Override chain: assignee.auth_level → template.default_auth_level → "public".
  // template.default_auth_level is non-null (DB default 'public' since the
  // auth-level migration) but we narrow defensively in case a legacy row
  // slipped through before the column was backfilled.
  //
  // H5 closure (silent-failure F5): if the column carries a corrupt /
  // unrecognised value, fall back to the safest tier ("public") AND log
  // so operators can surface and fix the bad row. Without the log this
  // would silently downgrade auth tier on every materialisation.
  let tplAuthLevel: "public" | "email_otp" | "account";
  if (isAuthLevel(template.default_auth_level)) {
    tplAuthLevel = template.default_auth_level;
  } else {
    console.error("Template default_auth_level invalid; falling back to 'public'", {
      template_id: template.id,
      raw_value: template.default_auth_level,
    });
    tplAuthLevel = "public";
  }
  const auth_level: "public" | "email_otp" | "account" =
    a.auth_level ?? tplAuthLevel;

  // Auth-tier-correct PII routing. The wire schema rejects misrouted
  // contextual fields upstream for the chain path; this resolver scrubs as
  // defense-in-depth for direct tokenService.generate callers (manual
  // route, future SDK callers, raw service-layer test calls). Both layers
  // serve distinct caller populations — neither subsumes the other.
  const auth_email = auth_level === "email_otp" ? (a.auth_email ?? null) : null;
  const auth_user_id = auth_level === "account" ? (a.auth_user_id ?? null) : null;

  // recipient_label / purpose override chain: assignee → step.name →
  // hardcoded "(chain step)" / "(chain-generated)" fallback. Both are
  // operator-authored UI labels with no PII expectation.
  const recipient_label = a.recipient_label ?? stepDefinition.name ?? "(chain step)";
  const purpose = a.purpose ?? stepDefinition.name ?? "(chain-generated)";

  // Expiry override chain: assignee.expires_in_seconds →
  // template.default_expiry_seconds → 7-day fallback. Convert to whole
  // hours (tokenService.generate accepts expiryHours). Floor to 1 to
  // avoid 0-hour tokens that would expire immediately (matches the manual
  // route's z.number().int().min(1) gate).
  const expirySeconds =
    a.expires_in_seconds ??
    template.default_expiry_seconds ??
    DEFAULT_EXPIRY_SECONDS_FALLBACK;
  const expiryHours = Math.max(1, Math.round(expirySeconds / 3600));

  return {
    auth_level,
    auth_email,
    auth_user_id,
    recipient_label,
    purpose,
    expiryHours,
  };
}

/**
 * Scrub the assignee identity from a FUTURE (pending/non-completed) chain step
 * so non-privileged callers cannot see who will review downstream steps.
 *
 * The step projection shape stores the full ChainDefinitionStep in
 * `assignee_spec`. For future steps, `assignee_spec.assignee` is reduced to
 * `{ kind }` only — stripping email, user_id, role, auth_level, etc. — so an
 * upstream caller/reviewer cannot determine who the downstream reviewer is.
 *
 * Active, approved, and rejected steps have already been actioned and their
 * assignee identity is forensically observable; they are returned unchanged.
 * Privileged callers (admin session or chain owner) always receive the full
 * spec regardless of step status.
 *
 * API-key callers are not owners and receive kind-only on pending steps.
 */
export function scrubFutureStepAssigneeSpec<
  T extends { status?: string; assignee_spec?: unknown },
>(step: T, opts: { isPrivileged: boolean }): T {
  if (opts.isPrivileged) return step;
  // Only scrub future (not-yet-actioned) steps.
  if (
    step.status === "active" ||
    step.status === "approved" ||
    step.status === "rejected"
  ) {
    return step;
  }
  const spec = step.assignee_spec;
  if (!spec || typeof spec !== "object") return step;
  const specObj = spec as Record<string, unknown>;
  const assignee = specObj.assignee;
  if (!assignee || typeof assignee !== "object") return step;
  return {
    ...step,
    assignee_spec: {
      ...specObj,
      assignee: { kind: (assignee as { kind?: string }).kind },
    },
  };
}

/**
 * Scrub recipient-PII fields from a chain step `assignee_spec` value before
 * any external serialization (webhook payload, GET projection, audit
 * detail).
 *
 * external_token assignees may carry `auth_email` + `auth_user_id` at rest
 * in `chain_steps.assignee_spec` (operator's pinning intent, persisted for
 * materialization). These fields MUST be absent from any external surface;
 * the pattern is project-wide (PII-as-type-absence).
 *
 * Single source of truth for assignee-spec PII scrubbing. Used by:
 *   - chain.next_step_ready webhook emit (chain-engine.ts)
 *   - buildTranscript() consumed by chain.completed + chain.rejected
 *     webhook payloads (chain-engine.ts + chain-rejection.ts)
 *   - GET /chain-runs/:id, POST /chain-runs response, GET /reviews/:id/chain
 *     envelope projections (routes/chains.ts)
 *
 * Returns null when input is not an object. Returns input untouched when
 * the assignee is not external_token (no PII to scrub on user/role kinds).
 */
export function scrubAssigneeSpecPii(
  raw: unknown,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const step = raw as Record<string, unknown>;
  const assignee = step.assignee as Record<string, unknown> | undefined;
  if (!assignee || typeof assignee !== "object") return step;
  if (assignee.kind !== "external_token") return step;

  const { auth_email: _e, auth_user_id: _u, ...scrubbedAssignee } = assignee;
  void _e;
  void _u;
  return { ...step, assignee: scrubbedAssignee };
}

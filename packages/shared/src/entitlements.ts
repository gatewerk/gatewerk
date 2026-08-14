// Canonical entitlement registry. Lives in @gatewerk/shared because both
// packages/db (Drizzle schema $type narrowing on projects.plan_id) and
// apps/api/ee/billing (entitlement resolver) need to import the types
// without crossing the db→api dependency boundary.

import { z } from "zod";

// Exhaustive list of every product gate. Adding a key here AND to
// PLAN_ENTITLEMENTS is the ONLY place a new gate is declared. The schema
// further down (EntitlementSchema) discriminates by key for parsing
// untrusted JSONB overrides.
export const ENTITLEMENT_KEYS = [
  "seat_count",                  // numeric: max active seats (omit = unlimited)
  "sso_saml",                    // Team+: SAML 2.0 SSO
  "audit_export",                // Solo+ (legacy) / Team+: CSV/JSON audit log export
  "priority_webhooks",           // Team+: managed webhook dispatcher
  "pgvector_feedback_memory",    // Business+: semantic feedback embedding store
  "hookdeck_dispatch",           // Business+: managed webhook routing/retries
  "custom_smtp",                 // Business+: customer-managed SMTP from UI
  "sla",                         // Business+: SLA-backed support contract
] as const;

export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

/**
 * Numeric-valued entitlement keys. Resolved via getSeatLimit() (returns
 * a number), NOT via hasEntitlement() (returns boolean — semantically wrong
 * for numeric quantities).
 */
export type NumericEntitlementKey = "seat_count";

/**
 * Boolean-valued entitlement keys (every key except seat_count). These are
 * the valid inputs to hasEntitlement() — the function signature constrains
 * callers at compile time so a misuse like hasEntitlement(..., "seat_count")
 * fails typecheck rather than silently returning false at runtime.
 */
export type BooleanEntitlementKey = Exclude<EntitlementKey, NumericEntitlementKey>;

// Discriminated union: numeric seat_count vs boolean for every other key.
// Zod 4 discriminator on "key" gives exhaustive parsing + actionable errors.
export const EntitlementSchema = z.discriminatedUnion("key", [
  z.object({
    key: z.literal("seat_count"),
    value: z.number().int().positive(),
  }),
  z.object({ key: z.literal("sso_saml"), value: z.literal(true) }),
  z.object({ key: z.literal("audit_export"), value: z.literal(true) }),
  z.object({ key: z.literal("priority_webhooks"), value: z.literal(true) }),
  z.object({ key: z.literal("pgvector_feedback_memory"), value: z.literal(true) }),
  z.object({ key: z.literal("hookdeck_dispatch"), value: z.literal(true) }),
  z.object({ key: z.literal("custom_smtp"), value: z.literal(true) }),
  z.object({ key: z.literal("sla"), value: z.literal(true) }),
]);

export type Entitlement = z.infer<typeof EntitlementSchema>;

// Canonical SKU identifiers stored in projects.plan_id. 4 tiers:
//   - community: OSS / Cloud-free (no entitlements)
//   - solo:      Legacy first-class tier; frozen for new signups but
//                grandfathered for existing customers (Cloud Solo Wave 1)
//   - team:      $49/mo
//   - business:  $149/mo
export const PLAN_IDS = ["community", "solo", "team", "business"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

// Source-of-truth bundle per SKU. Absence of a key = "not included";
// absence of seat_count specifically = unlimited seats. The
// projects.entitlements_override JSONB column is applied additively on top.
export const PLAN_ENTITLEMENTS: Record<PlanId, Entitlement[]> = {
  community: [
    // OSS / Cloud-free: no feature walls, no seat cap.
  ],
  solo: [
    // Legacy tier. Matches what Cloud Solo Wave 1 shipped — single seat,
    // audit-export available, no SSO/SCIM/SLA. New signups can't pick this
    // (UI filters), but existing solo customers continue to be honored.
    { key: "seat_count", value: 1 },
    { key: "audit_export", value: true },
  ],
  team: [
    { key: "seat_count", value: 5 },
    { key: "sso_saml", value: true },
    { key: "audit_export", value: true },
    { key: "priority_webhooks", value: true },
  ],
  business: [
    { key: "seat_count", value: 999 },           // practical "unlimited" ceiling
    { key: "sso_saml", value: true },
    { key: "audit_export", value: true },
    { key: "priority_webhooks", value: true },
    { key: "pgvector_feedback_memory", value: true },
    { key: "hookdeck_dispatch", value: true },
    { key: "custom_smtp", value: true },
    { key: "sla", value: true },
  ],
};

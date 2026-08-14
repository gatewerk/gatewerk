/**
 * surface-tiers — the product's configuration surface, DECLARED.
 *
 * ## Why this file exists
 *
 * Surface used to be *emergent*: any knob anyone added automatically appeared
 * somewhere, because nothing said it should not. Twenty template settings and
 * thirteen knobs per action were an accumulation, not a design. A one-time
 * cleanup does not fix that — the accumulation restarts the following week.
 *
 * This file inverts the default. Every configuration axis must be assigned a
 * tier here before it can exist. `scripts/audit-surface.mjs` fails the build
 * when a live schema carries an axis this file does not classify, so adding a
 * knob stops the build until someone decides where it lives.
 *
 * ## What it does NOT do
 *
 * Nothing here changes runtime behaviour. Every axis below still validates,
 * persists and is honoured exactly as it was. A tier is a statement about
 * where a control is *surfaced to a human*, not about whether it works.
 *
 * **Hide, never delete**. A held capability is
 * inventory, not debt. Nothing in this file is a deletion list.
 *
 * ## Enforcement is two-layered, on purpose
 *
 * 1. **The type system.** Each table below is a `Record<K, AxisDeclaration>`
 *    where `K` is derived from the live Zod schema with `keyof z.infer<...>`.
 *    Add a key to a request-body schema in this package and `pnpm typecheck`
 *    fails immediately; reference an axis that does not exist and it fails too.
 *    This is the fast loop, and it covers every schema that lives in
 *    `packages/shared`.
 * 2. **`scripts/audit-surface.mjs`.** Reflects the same schemas at runtime and
 *    additionally covers axes the type system cannot see from here — request
 *    bodies declared inline in `apps/api` routes, which `packages/shared` must
 *    not import (the dependency runs the other way). Those tables are marked
 *    `NOT TYPE-ENFORCED` below and the script is what holds them honest.
 */

export * from "./types";
export * from "./templates";
export * from "./reviews";
export * from "./chains";
export * from "./external";
export * from "./workspace";

import type { AxisDeclaration, LaunchSurface } from "./types";
import { TEMPLATE_AXES, ACTION_AXES, FIELD_AXES } from "./templates";
import { REVIEW_AXES } from "./reviews";
import { CHAIN_AXES, CHAIN_RUN_AXES } from "./chains";
import { TOKEN_AXES, RECIPIENT_AXES } from "./external";
import {
  NOTE_AXES,
  TEAM_AXES,
  NOTIFICATION_AXES,
  WEBHOOK_AXES,
  API_KEY_AXES,
  PROJECT_AXES,
  ACCOUNT_AXES,
} from "./workspace";

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Every table, keyed by the subsystem prefix used in axis ids.
 *
 * `audit-surface.mjs` walks this to diff declarations against live schemas, and
 * the roadmap generator walks it to build the public list. Adding a subsystem
 * means adding it here AND registering its schema source in the script — the
 * script fails if a registered source has no table.
 */
export const SURFACE_TIER_TABLES = {
  template: TEMPLATE_AXES,
  action: ACTION_AXES,
  field: FIELD_AXES,
  review: REVIEW_AXES,
  chain: CHAIN_AXES,
  chain_run: CHAIN_RUN_AXES,
  token: TOKEN_AXES,
  recipient: RECIPIENT_AXES,
  note: NOTE_AXES,
  team: TEAM_AXES,
  notifications: NOTIFICATION_AXES,
  webhook: WEBHOOK_AXES,
  api_key: API_KEY_AXES,
  project: PROJECT_AXES,
  account: ACCOUNT_AXES,
} as const satisfies Record<string, Record<string, AxisDeclaration>>;

/**
 * What this file deliberately does NOT cover, and why.
 *
 * A gate that quietly bounds its own scope reads as "everything is declared"
 * when it is not — the exact failure the tier system exists to prevent. So the
 * exclusions are declared here, in source, rather than living in someone's head.
 *
 * Each of these is a candidate for its own gate later. None is a claim that the
 * surface does not matter.
 */
export const OUT_OF_SCOPE = [
  {
    surface: "Deployment environment (apps/api/src/env.ts, ~50 Zod keys; apps/web/src/env.ts)",
    reason:
      "A different surface asking a different question. `core` here means 'in the launch UI', and an env var is never a UI control — so tiering GATEWERK_MODE or SKIP_HIBP would make `core` mean two incompatible things. Env already has its own declaration (.env.example) and its own enforcement (a Zod schema that refuses to boot). It deserves a parity gate of its own: env.ts versus .env.example versus the self-hosting docs.",
    examples: ["GATEWERK_MODE", "SESSION_INACTIVITY_TIMEOUT_HOURS", "SKIP_HIBP", "SMTP_FROM_TX", "VITE_BILLING_WAITLIST"],
  },
  {
    surface: "Client-side integration parameters (packages/n8n-nodes-gatewerk)",
    reason:
      "Real, user-settable axes that live in n8n's UI rather than ours, so the launch-surface vocabulary does not apply. Flagged regardless: the n8n node's waitTimeoutMinutes is a second, independent timeout layered on top of the review timeout, and its own description says so.",
    examples: ["resumeOn", "waitTimeoutMinutes", "trigger.events", "options.includeRawPayload"],
  },
  {
    surface: "Transient action bodies that persist no configuration",
    reason:
      "Test-ping endpoints send a request and store nothing. There is no surface question to answer about them.",
    examples: ["POST /settings/webhooks/test", "POST /settings/email/test"],
  },
  {
    surface: "Billing (apps/api/ee/**)",
    reason:
      "Proprietary, cloud-only, and gated behind BILLING_WAITLIST for launch. Its plan surface is governed by packages/shared/src/cloud.ts and a checkout test that encodes the pricing ruling directly.",
    examples: ["checkout plan_id"],
  },
  {
    surface: "Database columns no client can write",
    reason:
      "An axis has to be settable. These are dead configuration columns — worth deleting or wiring, but they are an S5 cleanup rather than a surface-tiering question. Recorded here so the finding is not lost: organizations.cloud_config has neither a reader nor a writer, projects.seat_count has neither, projects.entitlements_override is read by the entitlement resolver and written by nothing, and organizations.billing_email is read once at checkout and written by nothing (so the Stripe email is permanently the acting reviewer's).",
    examples: ["organizations.cloud_config", "projects.seat_count", "projects.entitlements_override", "organizations.billing_email"],
  },
] as const;

export type SubsystemName = keyof typeof SURFACE_TIER_TABLES;

/** Flattened `subsystem.axis` view, for the gate and the generators. */
export function allDeclaredAxes(): Array<{
  subsystem: SubsystemName;
  axis: string;
  axisId: string;
  declaration: AxisDeclaration;
}> {
  const out: Array<{
    subsystem: SubsystemName;
    axis: string;
    axisId: string;
    declaration: AxisDeclaration;
  }> = [];
  for (const [subsystem, table] of Object.entries(SURFACE_TIER_TABLES)) {
    for (const [axis, declaration] of Object.entries(
      table as Record<string, AxisDeclaration>,
    )) {
      out.push({
        subsystem: subsystem as SubsystemName,
        axis,
        axisId: `${subsystem}.${axis}`,
        declaration,
      });
    }
  }
  return out;
}

/** Distinct control groups a surface exposes. This is what the budgets count. */
export function controlGroupsOn(surface: LaunchSurface): string[] {
  const groups = new Set<string>();
  for (const { declaration } of allDeclaredAxes()) {
    if (
      (declaration.tier === "core" || declaration.tier === "advanced") &&
      declaration.surface === surface
    ) {
      groups.add(declaration.group);
    }
  }
  return Array.from(groups).sort();
}

/**
 * The public roadmap, grouped by feature line and split built-vs-not-started —
 * two different promises, kept apart.
 */
export function publicRoadmap(): Array<{
  feature: string;
  built: boolean;
  axes: string[];
}> {
  const byFeature = new Map<string, { built: boolean; axes: string[] }>();
  for (const { axisId, declaration } of allDeclaredAxes()) {
    if (declaration.tier !== "roadmap") continue;
    const existing = byFeature.get(declaration.roadmap.feature);
    if (existing) {
      existing.axes.push(axisId);
      // A feature line is only "built" if every axis behind it is.
      existing.built = existing.built && declaration.roadmap.built;
    } else {
      byFeature.set(declaration.roadmap.feature, {
        built: declaration.roadmap.built,
        axes: [axisId],
      });
    }
  }
  return Array.from(byFeature.entries())
    .map(([feature, v]) => ({ feature, built: v.built, axes: v.axes.sort() }))
    .sort((a, b) => (a.built === b.built ? a.feature.localeCompare(b.feature) : a.built ? -1 : 1));
}

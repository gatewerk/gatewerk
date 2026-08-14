import { eq } from "drizzle-orm";
import { templates } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import { ConflictError, type ChainDefinitionStep } from "@gatewerk/shared";

// SMTP guard for chain createRun (lifecycle map §11.5).
//
// An email_otp external_token step on a SMTP-less instance would let the run
// materialise but strand the recipient at "Code sent" — anti-enumeration on
// the OTP endpoint hides the failure silently. Fail-fast at createRun so
// nothing is half-created (guard runs BEFORE the insert transaction).
//
// Extracted from chain-engine.ts to keep that file under the 600 LOC hard cap.

/**
 * Throws ConflictError("smtp_not_configured") when any external_token step
 * in `steps` resolves to auth_level "email_otp" and `isEmailConfigured` is
 * absent or returns false (default-deny, mirrors the route-layer guard in
 * routes/reviews/tokens.ts).
 *
 * Resolution precedence mirrors resolveChainTokenInputs:
 *   assignee.auth_level → template.default_auth_level → "public"
 *
 * C1: the template whose default is consulted is the route's ENTRY template,
 * because that is the template every step materialises against. `entryTemplate`
 * is optional so the pre-C1 call shape still compiles; when absent the guard
 * falls back to each step's own template slug.
 *
 * Only queries the DB when at least one external_token step lacks an explicit
 * auth_level, keeping the common explicit-level case query-free.
 */
export async function assertSmtpForExternalTokenSteps(
  db: AppDb,
  projectId: string,
  steps: ChainDefinitionStep[],
  isEmailConfigured: (() => boolean) | undefined,
  entryTemplate?: string,
): Promise<void> {
  if (isEmailConfigured?.()) return;

  const externalSteps = steps.filter((s) => s.assignee.kind === "external_token");
  if (externalSteps.length === 0) return;

  const needsDbCheck = externalSteps.some(
    (s) => s.assignee.kind === "external_token" && (s.assignee as any).auth_level === undefined,
  );

  const slugFor = (step: ChainDefinitionStep): string | undefined =>
    entryTemplate ?? step.template;

  let templateDefaults: Map<string, string> = new Map();
  if (needsDbCheck) {
    const slugs = [
      ...new Set(externalSteps.map(slugFor).filter((s): s is string => s !== undefined)),
    ];
    const rows = await db
      .select({ slug: templates.slug, default_auth_level: templates.default_auth_level })
      .from(templates)
      .where(eq(templates.project_id, projectId));
    for (const r of rows) {
      if (slugs.includes(r.slug)) templateDefaults.set(r.slug, r.default_auth_level ?? "public");
    }
  }

  for (const step of externalSteps) {
    const assignee = step.assignee as any;
    const slug = slugFor(step);
    const effectiveLevel: string =
      assignee.auth_level ?? (slug ? templateDefaults.get(slug) : undefined) ?? "public";
    if (effectiveLevel === "email_otp") {
      throw new ConflictError(
        "Email OTP chain steps require email sending to be configured. Set SMTP_FROM and the SMTP_* variables in your environment and restart the API, or use public or account link steps.",
        "smtp_not_configured",
      );
    }
  }
}

import { eq, and } from "drizzle-orm";
import { templates, chainSteps } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import { InvalidRequestError, type ChainDefinition } from "@gatewerk/shared";

// Entry-template resolution for chains (C1, charter §5).
//
// A chain is a ROUTE OF APPROVERS, not a pipeline of stages: one request, one
// payload, several named humans in order. Every step of a route materialises a
// review against the SAME template, so "which template does this route use" is
// a single question asked in three places (createRun, handleApprove,
// handleReject) and answered here.
//
// Leaf module, mirroring chain-engine-abort.ts / -reconcile.ts / -owner.ts:
// chain-engine.ts imports it and it imports nothing from the engine. Extracted
// to keep chain-engine.ts under the 600 LOC cap.

/**
 * The slug of the one template every step of a route materialises against.
 *
 * Resolution order, most specific first:
 *   1. `override` — the caller already knows it. The POST /reviews spawn path
 *      resolved the template the chain_config hangs off before the engine was
 *      reached, so it passes the slug rather than making the definition repeat
 *      what the page it lives on already says.
 *   2. `definition.template` — the envelope names it. This is how POST
 *      /chain-runs, which has no owning template, supplies one.
 *   3. `steps[0].template` — legacy fallback, and the only place `step.template`
 *      is still read. A chain_config written before C1 carries no envelope
 *      template; step 1 then behaves exactly as it did, and later steps inherit
 *      step 1's template instead of their own. That is the route model applied
 *      to old data, and it means no migration.
 */
export function resolveEntryTemplateSlug(
  definition: ChainDefinition,
  override?: string,
): string {
  const slug = override || definition.template || definition.steps[0]?.template;
  if (!slug) {
    throw new InvalidRequestError(
      "Chain definition names no template. Set `template` on the chain.",
      "template",
      "entry_template_required",
    );
  }
  return slug;
}

/**
 * Load the route's entry template, or refuse the run.
 *
 * Replaces the pre-C1 `assertTemplatesExist`, which validated one slug per
 * step. Under the route model there is exactly one template to check, and the
 * row is needed anyway so createRun can record `chain_runs.template_id`.
 */
export async function loadEntryTemplate(db: AppDb, projectId: string, slug: string) {
  const [tpl] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.slug, slug), eq(templates.project_id, projectId)))
    .limit(1);
  if (!tpl) {
    throw new InvalidRequestError(
      `Template '${slug}' not found in project`,
      "template",
      "template_not_found",
    );
  }
  return tpl;
}

/**
 * The route's entry template slug for a materialisation that happens AFTER
 * createRun returned.
 *
 * The engine does not hold the definition across the decision → advance async
 * boundary, so it reads `chain_runs.template_id` (written at createRun). A run
 * created before C1 has NULL there; for those the route is pinned to STEP
 * ONE's stored template, matching resolveEntryTemplateSlug's legacy branch.
 */
export async function entryTemplateSlugForRun(
  db: AppDb,
  run: { id: string; template_id: string | null },
): Promise<string> {
  if (run.template_id) {
    const [tpl] = await db
      .select({ slug: templates.slug })
      .from(templates)
      .where(eq(templates.id, run.template_id))
      .limit(1);
    if (tpl) return tpl.slug;
  }

  // Legacy fallback: read STEP ONE's stored definition, not the step that
  // happens to be advancing. resolveEntryTemplateSlug's branch 3 pins the
  // route to steps[0].template, and reading the current step instead would
  // let the entry template drift one step per advance — a third semantics
  // matching neither the old pipeline model nor the new route model.
  const [firstStep] = await db
    .select({ assignee_spec: chainSteps.assignee_spec })
    .from(chainSteps)
    .where(and(eq(chainSteps.chain_run_id, run.id), eq(chainSteps.step_number, 1)))
    .limit(1);
  const spec = firstStep?.assignee_spec as { template?: string } | null;
  if (spec?.template) return spec.template;

  throw new InvalidRequestError(
    `Chain run ${run.id} names no template`,
    "template",
    "entry_template_required",
  );
}

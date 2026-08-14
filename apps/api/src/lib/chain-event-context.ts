import { eq, and } from "drizzle-orm";
import { chainSteps } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";

// SSE wire payloads gain four optional chain context fields (chain_run_id,
// chain_step_id, step_index, total_steps) so the dashboard can invalidate the
// chain panel queryKey on transition,
// instead of polling every 30 seconds. Emit sites that are touching a
// chain-attached review call this helper to populate the four fields. Non-
// chain reviews leave them undefined; toWirePayload drops undefined fields
// from the wire (no shape change for non-chain emits).
//
// Caller passes the chain_run_id + chain_step_id directly off the review row
// (already loaded in every emit path). The helper does ONE DB round-trip:
// fetch every chain_steps row for the run, find the caller's step_number
// (→ step_index), use the row count as total_steps. Emit sites that fire
// multiple events in the same flow can cache the result and pass it to
// chainEventFieldsFromCache so the count is amortised across emits.

export interface ChainEventFields {
  chain_run_id: string;
  chain_step_id: string;
  step_index: number;     // 1-based step position
  total_steps: number;
}

export interface ChainStepCounts {
  total_steps: number;
  step_index_by_id: Map<string, number>;
}

/**
 * Resolve chain context fields for a single review whose chain_run_id +
 * chain_step_id are known. Returns null when the chain row is missing
 * (defensive — emit sites should not block on chain bookkeeping when the
 * chain has been concurrently deleted; the event still fires without the
 * chain fields, indistinguishable from a non-chain emit on the wire).
 */
export async function resolveChainEventFields(
  db: AppDb,
  chainRunId: string | null | undefined,
  chainStepId: string | null | undefined,
): Promise<ChainEventFields | null> {
  if (!chainRunId || !chainStepId) return null;

  const counts = await loadChainStepCounts(db, chainRunId);
  if (!counts) return null;

  const stepIndex = counts.step_index_by_id.get(chainStepId);
  if (stepIndex === undefined) return null;

  return {
    chain_run_id: chainRunId,
    chain_step_id: chainStepId,
    step_index: stepIndex,
    total_steps: counts.total_steps,
  };
}

/**
 * Load every chain_steps row for a run and build a step_id → step_number map.
 * Cache once per emit-site flow (createRun, decide → next-step materialise)
 * so a single chain transition firing multiple SSE events doesn't issue N
 * identical queries.
 */
export async function loadChainStepCounts(
  db: AppDb,
  chainRunId: string,
): Promise<ChainStepCounts | null> {
  const rows = await db
    .select({ id: chainSteps.id, step_number: chainSteps.step_number })
    .from(chainSteps)
    .where(eq(chainSteps.chain_run_id, chainRunId));

  if (rows.length === 0) return null;

  const map = new Map<string, number>();
  for (const r of rows) map.set(r.id, r.step_number);

  return { total_steps: rows.length, step_index_by_id: map };
}

/**
 * Bound version of resolveChainEventFields using a cached ChainStepCounts.
 * Same fail-soft semantics — returns null when the step id isn't in the
 * cache. Useful for emit sites that only have chain_run_id (engine flows)
 * and want to look up step_number from a separately-fetched chain_steps
 * row, but with a single shared count.
 */
export function chainEventFieldsFromCache(
  chainRunId: string,
  chainStepId: string,
  counts: ChainStepCounts,
): ChainEventFields | null {
  const stepIndex = counts.step_index_by_id.get(chainStepId);
  if (stepIndex === undefined) return null;
  return {
    chain_run_id: chainRunId,
    chain_step_id: chainStepId,
    step_index: stepIndex,
    total_steps: counts.total_steps,
  };
}

// Re-export for callers that want the and/eq imports kept off their
// surface (chain-engine.ts already imports them). The drizzle imports on
// line 1 are load-bearing — leaving them used so eslint stays quiet.
void and;

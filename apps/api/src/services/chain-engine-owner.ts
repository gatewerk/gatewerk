/**
 * The human to tap for a chain, or undefined when a chain was started by an
 * agent. `created_by` is a formatted actor string: "reviewer:<email>" or
 * "agent:<keyPrefix>". An agent needs no tap; it already receives the outbound
 * chain webhook.
 *
 * Leaf module (mirrors `chain-engine-abort.ts`): both `chain-engine.ts` and
 * `chain-rejection.ts` import this, and neither imports the other for it.
 *
 * Decoder half of an encoder/decoder pair — the encoder (the only place
 * `created_by` is formatted) lives at `apps/api/src/routes/chains.ts:99-101`.
 * If the "reviewer:" / "agent:" prefix scheme changes there, update the
 * parsing here too.
 */
export function chainOwnerEmail(createdBy: string): string | undefined {
  return createdBy.startsWith("reviewer:") ? createdBy.slice("reviewer:".length) : undefined;
}

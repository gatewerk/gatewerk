// Normalizes a review response shape so `template` is always present — either the
// enriched embed (when getByIdWithTemplate's leftJoin produced one) or null. Mutation
// service methods (decide/retry/etc) return just the DB row; this guarantees the wire
// shape stays aligned with ReviewObjectSchema's tightened contract.
export function reviewPayload<T extends object>(review: T): T & { template: unknown } {
  return { template: null, ...(review as T & { template?: unknown }) } as T & { template: unknown };
}

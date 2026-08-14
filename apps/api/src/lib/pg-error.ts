// Postgres error introspection that survives drizzle's error wrapping.
//
// drizzle-orm >= 0.44 wraps EVERY driver error thrown from a session in a
// `DrizzleQueryError` (drizzle-orm/pg-core/session.js, so this is
// driver-independent — node-postgres, postgres.js and PGlite all behave the
// same). The wrapper carries only `{ query, params, cause }`: its own `.code`
// and `.constraint` are `undefined`, and the real Postgres fields live on
// `.cause`.
//
// That silently killed every `err.code === "23505"` guard in this codebase.
// Each one had been written against the pre-wrapping shape, so each one
// stopped matching and started re-throwing, turning a handled constraint
// collision into a 500:
//
//   * routes/templates.ts        duplicate template slug -> 500, not 400
//   * services/templates.ts      colliding first publish -> 500
//   * routes/reviews/crud.ts     concurrent idempotency_key retry -> 500,
//                                despite a comment promising "never a 500"
//   * ee/billing/webhook.ts      duplicate Stripe event -> 500, which Stripe
//                                then retries on a 5xx backoff
//
// None of it was caught because no test could reach these branches: the PGlite
// harness was missing the unique indexes the guards key on. Both halves are
// fixed together.
//
// The walk is depth-bounded rather than `while (err.cause)` so a self- or
// cyclically-referencing cause chain cannot spin.

const MAX_CAUSE_DEPTH = 5;

export interface PgErrorFields {
  code?: string;
  constraint?: string;
}

/**
 * Pull the Postgres `code` / `constraint` out of an error, unwrapping
 * drizzle's DrizzleQueryError (and any future nesting) to find them.
 * Returns an empty object for non-Postgres errors.
 */
export function pgErrorFields(err: unknown): PgErrorFields {
  let current = err as { code?: unknown; constraint?: unknown; cause?: unknown } | null | undefined;

  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
    const code = typeof current.code === "string" ? current.code : undefined;
    const constraint = typeof current.constraint === "string" ? current.constraint : undefined;
    if (code || constraint) return { code, constraint };
    current = current.cause as typeof current;
  }

  return {};
}

/**
 * True when `err` is a Postgres unique-violation (23505). When
 * `constraintName` is supplied, the violated constraint must match it —
 * use that form so a guard written for one index cannot silently swallow a
 * collision on a different one.
 */
export function isUniqueViolation(err: unknown, constraintName?: string): boolean {
  const { code, constraint } = pgErrorFields(err);
  if (code !== "23505") return false;
  return constraintName === undefined || constraint === constraintName;
}

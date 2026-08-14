export type PaginationParams = { limit: number; offset: number };

// One parser for ?limit&offset list routes. Clamps: limit in (0, maxLimit],
// non-numeric/absent → defaultLimit; offset >= 0, non-numeric/absent → 0.
export function parsePagination(
  query: Record<string, unknown>,
  opts: { defaultLimit?: number; maxLimit?: number } = {},
): PaginationParams {
  const { defaultLimit = 50, maxLimit = 100 } = opts;
  const rawLimit = parseInt(String(query.limit ?? ""), 10);
  const rawOffset = parseInt(String(query.offset ?? ""), 10);
  const limit = Math.min(
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : defaultLimit,
    maxLimit,
  );
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return { limit, offset };
}
